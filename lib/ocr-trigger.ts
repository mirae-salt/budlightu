/**
 * Reliable OCR trigger (P1-13, audit 2026-08-07).
 *
 * The old pattern was a bare `fetch(...)` that was neither awaited nor wrapped in
 * `waitUntil`. On Vercel the invocation can be frozen the moment the response is
 * flushed, so the OCR call was never made and the receipt sat at status='pending'
 * forever. `pending` is invisible in the admin review queue
 * (app/api/admin/data/route.ts queues only 'review' and 'ocr_failed'), so those
 * dollars silently vanished for that BAM.
 *
 * Three layers now:
 *   1. `ocr_queued_at` is stamped on the receipt BEFORE the trigger, so a
 *      stranded receipt is always identifiable.
 *   2. The call is scheduled with Next's `after()` (a real keep-alive on Vercel),
 *      falling back to an inline await outside a request scope. If the call
 *      itself fails or returns non-2xx, the receipt is flipped to 'ocr_failed'
 *      so it appears in Robin's queue instead of disappearing.
 *   3. Backstop: `sweep_stale_ocr_receipts()` (migration 0017), called by
 *      scheduler-audit, flips anything left at 'pending' past the cutoff to
 *      'ocr_failed'. Nothing stays invisible.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { stripInvisible } from './sanitize'

export const OCR_STALE_MINUTES = 15
export const OCR_UNSTARTED_PREFIX = 'ocr_not_started'

export type OcrTriggerResult = {
  /** true = the receipt is recorded as queued and a trigger was scheduled */
  queued: boolean
  via: 'after' | 'inline' | 'none'
  error?: string
}

/**
 * Make a receipt visible to admins instead of leaving it silently at 'pending'.
 * Only acts while the row is still 'pending' so it can never clobber a real
 * decision or the OCR route's own retry bookkeeping.
 */
export async function markOcrUnstarted(
  db: SupabaseClient,
  receiptId: string,
  reason: string
): Promise<void> {
  const { error } = await db.from('receipts')
    .update({
      status: 'ocr_failed',
      decision_reason: `${OCR_UNSTARTED_PREFIX}: ${reason}`.slice(0, 1000)
    })
    .eq('id', receiptId)
    .eq('status', 'pending')
  if (error) {
    console.error('[ocr-trigger] could not flag stranded receipt', receiptId, error.message)
    return
  }
  try {
    const { notifyAdmin } = await import('./notify-admin')
    await notifyAdmin({
      type: 'ocr_failed',
      title: 'Receipt OCR did not run',
      body: `Receipt ${receiptId.slice(0, 8)} needs a manual retry. ${reason}`,
      link: '/admin/receipts'
    })
  } catch (e) {
    console.error('[ocr-trigger] notifyAdmin failed:', e)
  }
}

export async function triggerOcr(
  db: SupabaseClient,
  args: { receiptId: string; storageKey: string; baseUrl: string }
): Promise<OcrTriggerResult> {
  const { receiptId, storageKey } = args
  const baseUrl = stripInvisible(args.baseUrl).trim().replace(/\/+$/, '')

  if (!baseUrl) {
    await markOcrUnstarted(db, receiptId, 'no base URL available to call the OCR endpoint')
    return { queued: false, via: 'none', error: 'missing baseUrl' }
  }

  // 1. Record the queue stamp first — this is what the sweeper reads.
  //    If the stamp fails (e.g. migration 0017 has not been applied yet) we still
  //    schedule the OCR call: the run itself flags the receipt on failure, so the
  //    receipt is never silently dropped. Only the *sweeper* backstop is lost, and
  //    that loss is logged loudly rather than assumed away.
  let stamped = true
  const { error: markErr } = await db.from('receipts')
    .update({ ocr_queued_at: new Date().toISOString(), ocr_started_at: null })
    .eq('id', receiptId)
  if (markErr) {
    stamped = false
    console.error('[ocr-trigger] could not stamp ocr_queued_at for', receiptId, '-', markErr.message,
      '- has migration 0017_receipt_ai_fixes.sql been applied? The stale-receipt sweeper cannot see this row.')
  }

  const run = async () => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const secret = stripInvisible(process.env.INTERNAL_API_SECRET ?? '').trim()
      if (secret) headers['x-internal-secret'] = secret

      const resp = await fetch(`${baseUrl}/api/receipts/ocr`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ receipt_id: receiptId, storage_key: storageKey })
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        await markOcrUnstarted(db, receiptId, `OCR endpoint returned ${resp.status}. ${body.slice(0, 300)}`)
      }
    } catch (e) {
      await markOcrUnstarted(db, receiptId, `OCR endpoint call threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 2. Schedule it so the platform keeps the invocation alive.
  try {
    after(run)
    return { queued: true, via: 'after', ...(stamped ? {} : { error: 'ocr_queued_at could not be stamped (sweeper backstop unavailable)' }) }
  } catch {
    // outside a request scope (script / test) — do it inline so it still happens
    await run()
    return { queued: true, via: 'inline', ...(stamped ? {} : { error: 'ocr_queued_at could not be stamped (sweeper backstop unavailable)' }) }
  }
}
