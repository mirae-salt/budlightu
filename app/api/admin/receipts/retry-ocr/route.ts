/**
 * POST /api/admin/receipts/retry-ocr  { receipt_id }
 *
 * P1-13b (audit 2026-08-07): this used to reset only status + ocr_attempts and never
 * checked the update error, leaving `ocr_json` and `bud_light_total_incl_tax` populated.
 * A row could therefore carry a stale dollar amount while its status excluded it from
 * both scheduler-audit and the invoice path: money disappeared while the row looked
 * fine. The stale fields are now cleared, and the write is verified.
 *
 * P1-13: the OCR call itself goes through triggerOcr(), which records the queue stamp
 * and makes a dropped trigger visible instead of stranding the receipt at 'pending'.
 *
 * P0-A: this route had NO authorization check at all. It runs on the service-role
 * client and rewrites a receipt's amount fields, so an unauthenticated caller could
 * wipe a decided amount for any receipt id. It now requires an admin.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { triggerOcr } from '../../../../../lib/ocr-trigger'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const { receipt_id } = await req.json()
  if (!receipt_id) return NextResponse.json({ ok: false, message: 'receipt_id required' }, { status: 400 })

  const admin = serviceClient()
  const { data: receipt, error: readErr } = await admin.from('receipts')
    .select('id, storage_key, status, bud_light_total_incl_tax')
    .eq('id', receipt_id).maybeSingle()
  if (readErr) return NextResponse.json({ ok: false, message: readErr.message }, { status: 500 })
  if (!receipt) return NextResponse.json({ ok: false, message: 'receipt not found' }, { status: 404 })
  if (!receipt.storage_key) return NextResponse.json({ ok: false, message: 'no storage_key, cannot retry' }, { status: 400 })

  // Clear every field derived from the previous OCR run so no stale amount survives.
  const { data: reset, error: resetErr } = await admin.from('receipts').update({
    status: 'pending',
    ocr_attempts: 0,
    ocr_json: null,
    bud_light_total_incl_tax: null,
    confidence: null,
    ambiguous_flags: null,
    decision_reason: 'OCR retry requested by admin',
    decided_by: null,
    decided_at: null
  }).eq('id', receipt_id).select('id, status, bud_light_total_incl_tax')

  if (resetErr) {
    return NextResponse.json({ ok: false, message: `could not reset receipt: ${resetErr.message}` }, { status: 500 })
  }
  if (!reset || reset.length !== 1) {
    return NextResponse.json({ ok: false, message: `reset affected ${reset?.length ?? 0} rows, expected 1` }, { status: 500 })
  }
  if (reset[0].bud_light_total_incl_tax !== null) {
    // Read-back: the stale amount is the whole point of this fix.
    return NextResponse.json({ ok: false, message: 'stale amount was not cleared, aborting retry' }, { status: 500 })
  }

  const trigger = await triggerOcr(admin, {
    receiptId: receipt.id,
    storageKey: receipt.storage_key,
    baseUrl: req.nextUrl.origin
  })

  if (!trigger.queued) {
    return NextResponse.json({
      ok: false,
      message: `OCR could not be queued: ${trigger.error ?? 'unknown error'}. The receipt is flagged for manual review.`
    }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    message: 'OCR retry queued. Refresh in a few seconds.',
    cleared_previous_total: receipt.bud_light_total_incl_tax
  })
}
