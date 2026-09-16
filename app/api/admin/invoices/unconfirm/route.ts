/**
 * POST /api/admin/invoices/unconfirm  { invoice_id, reason }
 *
 * Takes back a BAM's confirmation, so the invoice waits out its window again instead of
 * being clear to send.
 *
 * WHY AN ADMIN CAN UNDO THIS AND THE BAM CANNOT
 * ---------------------------------------------
 * Confirming waives a protection that exists for the BAM (0037), and the realistic way it
 * goes wrong is a student pressing it before they have read anything. Until now the only
 * way back was Mirae editing the database by hand, which is the definition of a missing
 * feature. Nothing else in this flow required that, and this should not either.
 *
 * It is an admin action because the student pressing "undo" adds nothing: they can raise a
 * question instead, which blocks the send outright and gets a person involved.
 *
 * WHAT IT DOES NOT TOUCH
 * ----------------------
 * Only `accepted_at`. The release stamp, the window and any question thread stay exactly
 * as they were, so undoing a confirmation returns the invoice to the state it was in a
 * moment earlier rather than to some third state nobody has seen.
 *
 * A reason is required and audited. This removes a recorded agreement, and in three months
 * the only account of why will be this sentence.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'

const MIN_REASON = 5

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const body = await req.json().catch(() => ({}))
  const invoiceId = typeof body?.invoice_id === 'string' ? body.invoice_id : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''

  if (!invoiceId) {
    return NextResponse.json({ ok: false, message: 'invoice_id required' }, { status: 400 })
  }
  if (reason.length < MIN_REASON) {
    return NextResponse.json({
      ok: false,
      message: `Say why, in at least ${MIN_REASON} characters. This undoes something the BAM agreed to.`
    }, { status: 400 })
  }

  const admin = serviceClient()

  const { data: invoice, error: readErr } = await admin.from('invoices')
    .select('id, invoice_number, bam_id, period, status, accepted_at')
    .eq('id', invoiceId)
    .maybeSingle()
  if (readErr) {
    return NextResponse.json({ ok: false, message: `could not read that invoice: ${readErr.message}` }, { status: 500 })
  }
  if (!invoice) {
    return NextResponse.json({ ok: false, message: 'Invoice not found' }, { status: 404 })
  }
  if (!invoice.accepted_at) {
    return NextResponse.json({ ok: false, message: 'That invoice has not been confirmed.' }, { status: 409 })
  }
  if (invoice.status !== 'draft') {
    // Once it has gone there is nothing to hold back, and clearing the stamp would only
    // make the record disagree with what happened.
    return NextResponse.json({
      ok: false,
      message: `This invoice is already ${invoice.status}. Void it instead if it has to change.`
    }, { status: 409 })
  }

  // Read back, and only from the confirmed state: two admins undoing the same one must not
  // both be told they did it.
  const { data: updated, error: upErr } = await admin.from('invoices')
    .update({ accepted_at: null })
    .eq('id', invoiceId)
    .eq('status', 'draft')
    .not('accepted_at', 'is', null)
    .select('id, accepted_at')
  if (upErr) {
    return NextResponse.json({ ok: false, message: `could not undo it: ${upErr.message}` }, { status: 500 })
  }
  if (!updated || updated.length !== 1) {
    return NextResponse.json({ ok: false, message: 'Someone else changed that one just now.' }, { status: 409 })
  }

  const { error: auditErr } = await admin.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'invoices',
    entity_id: invoiceId,
    action: 'confirmation_revoked',
    before_json: { accepted_at: invoice.accepted_at },
    after_json: { accepted_at: null, reason, revoked_by: auth.email ?? auth.userId }
  })

  return NextResponse.json({
    ok: true,
    // Said rather than swallowed: the undo happened either way, and an audit gap on a
    // money-adjacent reversal is the thing somebody needs to know about.
    audit_logged: !auditErr,
    ...(auditErr ? { warning: `the undo was applied but the audit entry failed: ${auditErr.message}` } : {})
  })
}
