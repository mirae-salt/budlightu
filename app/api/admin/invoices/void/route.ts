/**
 * POST /api/admin/invoices/void  { invoice_id, reason }
 * Voids an invoice. When the invoice had already been SENT, a DB trigger
 * auto-creates an AP cancellation draft (see
 * supabase/migrations/0007_void_ap_cancellation.sql). The program admin sends it
 * manually from admin/invoices/[id]/cancellation.
 *
 * AUDIT-2026-08-07 (P1-16) fix: this route used to ignore the affected row count
 * and always answer "AP cancellation draft auto-generated". The trigger only
 * fires when old.status='sent', so voiding a draft produced that message with no
 * draft behind it — and a void of a non-existent id also reported success
 * ("0 rows affected" is a finding, per ENGINEERING-RULES §3). It now confirms a
 * row actually changed and that the cancellation row really exists before
 * claiming it.
 */
import { NextRequest, NextResponse } from 'next/server'
import { reasonProblem } from '../../../../../lib/reason'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'

export async function POST(req: NextRequest) {
  const { invoice_id, reason } = await req.json()
  const reasonIssue = reasonProblem(reason, 'Reason for voiding')
  if (!invoice_id) {
    return NextResponse.json({ ok: false, message: 'invoice_id is required.' }, { status: 400 })
  }
  if (reasonIssue) {
    return NextResponse.json({ ok: false, message: reasonIssue }, { status: 400 })
  }
  // P0-A: role from app_metadata only.
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const admin = serviceClient()

  // Read the current status first: it decides whether a cancellation draft can
  // exist at all, and it lets the update be a compare-and-set.
  const { data: existingRows, error: readErr } = await admin
    .from('invoices')
    .select('id, status, invoice_number')
    .eq('id', invoice_id)
  if (readErr) return NextResponse.json({ ok: false, error: readErr.message }, { status: 500 })

  const existing = (existingRows ?? [])[0]
  if (!existing) {
    return NextResponse.json({ ok: false, message: 'Invoice not found.' }, { status: 404 })
  }
  if (existing.status === 'void') {
    return NextResponse.json({ ok: false, message: 'Invoice is already void.' }, { status: 409 })
  }

  const previousStatus: string = existing.status

  const { data: updated, error } = await admin.from('invoices')
    .update({ status: 'void', void_reason: reason })
    .eq('id', invoice_id)
    .eq('status', previousStatus)
    .select('id')
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  if (!(updated ?? []).length) {
    return NextResponse.json(
      { ok: false, message: 'Invoice changed while voiding (status is no longer what we read). Reload and try again.' },
      { status: 409 }
    )
  }

  // The trigger only fires for sent → void. Verify rather than assume.
  let cancellationDraft = false
  let cancellationNote: string | undefined
  if (previousStatus === 'sent') {
    const { data: cancels, error: cancelErr } = await admin
      .from('ap_cancellations')
      .select('id')
      .eq('original_invoice_id', invoice_id)
    if (cancelErr) {
      cancellationNote = `Could not confirm the AP cancellation draft: ${cancelErr.message}. Check /admin/invoices/${invoice_id}/cancellation manually.`
    } else if ((cancels ?? []).length > 0) {
      cancellationDraft = true
      cancellationNote = `AP cancellation draft generated. Review and send it from /admin/invoices/${invoice_id}/cancellation`
    } else {
      cancellationNote = 'This invoice was already sent to AP but no cancellation draft was created. AP must be told manually.'
    }
  } else {
    cancellationNote = `Invoice was ${previousStatus} and had not been sent to AP, so no cancellation notice is needed.`
  }

  return NextResponse.json({
    ok: true,
    invoice_number: existing.invoice_number,
    previous_status: previousStatus,
    cancellation_draft: cancellationDraft,
    note: cancellationNote
  })
}
