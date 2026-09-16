/**
 * POST /api/portal/invoices/confirm  { invoice_id }
 *
 * The BAM says their invoice is correct, which lets it go to accounts payable without
 * waiting out the rest of the 24 hours (0037).
 *
 * WHAT IT WAIVES, AND WHAT IT DOES NOT
 * ------------------------------------
 * The wait, only. The invoice must still have been released, because you cannot accept a
 * figure you were never shown, and an unanswered question still holds it: that one is
 * Robin owing this student a reply, and a student pressing a button does not discharge
 * somebody else's obligation.
 *
 * WHY EXPLICIT ACCEPTANCE IS WORTH HAVING
 * ---------------------------------------
 * Silence for 24 hours is the weakest form of consent and the slowest. This is a person
 * saying the amount is right, recorded with a timestamp, which is both stronger evidence
 * and faster for everybody who is happy with their invoice.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireBam, denied } from '../../../../../lib/admin-auth'

export async function POST(req: NextRequest) {
  const auth = await requireBam()
  if (!auth.ok) return denied(auth)

  const body = await req.json().catch(() => ({}))
  const invoiceId = typeof body?.invoice_id === 'string' ? body.invoice_id : ''
  if (!invoiceId) {
    return NextResponse.json({ ok: false, message: 'invoice_id required' }, { status: 400 })
  }

  const admin = serviceClient()

  const { data: invoice, error: invErr } = await admin.from('invoices')
    .select('id, bam_id, status, released_at, accepted_at')
    .eq('id', invoiceId)
    .maybeSingle()
  if (invErr) {
    return NextResponse.json({ ok: false, message: `could not read that invoice: ${invErr.message}` }, { status: 500 })
  }
  // Same answer for "does not exist" and "is not yours", so this cannot be used to find
  // out whose invoice an id belongs to.
  if (!invoice || invoice.bam_id !== auth.bamId) {
    return NextResponse.json({ ok: false, message: 'Invoice not found' }, { status: 404 })
  }
  if (!invoice.released_at) {
    return NextResponse.json({
      ok: false,
      message: 'This invoice has not been finalised yet, so there is nothing to confirm. You will be told when it is ready.'
    }, { status: 400 })
  }
  if (invoice.status !== 'draft') {
    return NextResponse.json({
      ok: false,
      message: 'This invoice has already gone to accounts payable.'
    }, { status: 409 })
  }
  if (invoice.accepted_at) {
    return NextResponse.json({ ok: true, already: true, accepted_at: invoice.accepted_at })
  }

  const now = new Date().toISOString()
  // Read back, and only from the state we checked: a confirmation that matched no row is
  // not a confirmation, and this one lets a payment skip its waiting period.
  const { data: updated, error: upErr } = await admin.from('invoices')
    .update({ accepted_at: now })
    .eq('id', invoiceId)
    .eq('status', 'draft')
    .is('accepted_at', null)
    .select('id, accepted_at')
  if (upErr) {
    return NextResponse.json({ ok: false, message: `could not record that: ${upErr.message}` }, { status: 500 })
  }
  if (!updated || updated.length !== 1) {
    return NextResponse.json({
      ok: false,
      message: 'That did not save. Reload the page and try again.'
    }, { status: 409 })
  }

  return NextResponse.json({ ok: true, accepted_at: updated[0].accepted_at })
}
