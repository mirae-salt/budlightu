/**
 * Admin notification writer.
 *
 * P1-17: this function used to wrap the insert in try/catch. supabase-js does
 * NOT throw, so the catch was unreachable and the insert's `error` was never
 * read. Every admin notification (receipt review, shortfall, support question)
 * could vanish with no trace, which silently disables Robin's touchpoint 1.
 *
 * It now inspects `error` and returns the outcome. The exported name and the
 * single-argument call shape are unchanged, so existing fire-and-forget callers
 * keep compiling; callers that care can check the returned `ok`.
 *
 *   const res = await notifyAdmin({ ... })
 *   if (!res.ok) { // the notification did not land
 *
 * `notifyAdminOrThrow` is available where a lost notification should abort the
 * surrounding operation.
 */
import { serviceClient } from '../supabase/functions/_shared/supabase-admin'

type NotifType = 'receipt_review' | 'ocr_failed' | 'shortfall' | 'invoice_draft' | 'support_question' | 'receipt_uploaded'

interface AdminNotification {
  type: NotifType
  title: string
  body?: string
  bam_id?: string
  cohort_id?: string
  period?: string
  link?: string
}

export type NotifyResult = { ok: true; id: string | null } | { ok: false; error: string }

export async function notifyAdmin(n: AdminNotification): Promise<NotifyResult> {
  let db
  try {
    db = serviceClient()
  } catch (e) {
    // serviceClient() throws when env vars are missing. That is the only throw
    // on this path, and it is a configuration fault, not a query error.
    const error = `service client unavailable: ${(e as Error).message}`
    console.error('[notifyAdmin] DROPPED notification:', n.type, n.title, '-', error)
    return { ok: false, error }
  }

  const { data, error } = await db.from('admin_notifications').insert({
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    bam_id: n.bam_id ?? null,
    cohort_id: n.cohort_id ?? null,
    period: n.period ?? null,
    link: n.link ?? null,
  }).select('id')

  if (error) {
    console.error('[notifyAdmin] DROPPED notification:', n.type, n.title, '-', error.message)
    return { ok: false, error: error.message }
  }

  const rows = (data ?? []) as { id: string }[]
  if (rows.length === 0) {
    // Insert reported no error and no row. Do not call that a success.
    const msg = 'insert returned no row'
    console.error('[notifyAdmin] DROPPED notification:', n.type, n.title, '-', msg)
    return { ok: false, error: msg }
  }

  return { ok: true, id: rows[0].id }
}

/** Use where a lost notification must fail the surrounding operation. */
export async function notifyAdminOrThrow(n: AdminNotification): Promise<string | null> {
  const res = await notifyAdmin(n)
  if (!res.ok) throw new Error(`admin notification failed: ${res.error}`)
  return res.id
}
