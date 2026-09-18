/**
 * POST /api/admin/invoices/sync   { invoice_id }
 *
 * Pull the BAM's current roster details into one invoice.
 *
 * WHY A PULL EXISTS WHEN THE EDIT SCREENS ALREADY PUSH
 * ----------------------------------------------------
 * /admin/roster and the banking approval both call refreshOpenInvoices when they save,
 * which covers what people actually do. It does not cover everything that can write to
 * `bams`: onboarding ingest, a CSV import, a fix- script, a hand edit in the Supabase
 * dashboard. A push that missed one of those leaves an invoice quietly disagreeing with
 * the roster, and the only place the difference shows up is the PDF AP receives.
 *
 * So the invoices screen compares the two sides on every load and offers this when they
 * differ. Robin can repair it without a developer, which is the thing that was missing
 * when a bad postal code could block an invoice and there was no screen that could fix it.
 *
 * Banking is included here even though the drift badge does not check it. Reading stored
 * banking costs one decrypt per BAM, which is too much to render a list, but it is
 * nothing for a single invoice somebody is actively repairing.
 *
 * Money is never touched. Lines, subtotal, tax and total come out the way they went in;
 * a province change is reported rather than recalculated (lib/refresh-invoice-snapshot).
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import { refreshOpenInvoices } from '../../../../../lib/refresh-invoice-snapshot'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const body = await req.json().catch(() => ({}))
  const invoiceId = typeof body?.invoice_id === 'string' ? body.invoice_id : ''
  if (!UUID_RE.test(invoiceId)) {
    return NextResponse.json({ ok: false, message: 'A valid invoice_id is required.' }, { status: 400 })
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data: invRows, error: invErr } = await db.from('invoices')
    .select('id, invoice_number, bam_id, status')
    .eq('id', invoiceId)
  if (invErr) {
    return NextResponse.json({ ok: false, message: `Could not read that invoice: ${invErr.message}` }, { status: 500 })
  }
  const inv = (invRows ?? [])[0] as { id: string; invoice_number: string; bam_id: string; status: string } | undefined
  if (!inv) {
    return NextResponse.json({ ok: false, message: 'That invoice does not exist. Reload the page.' }, { status: 404 })
  }
  if (inv.status !== 'draft' && inv.status !== 'approved') {
    // A sent invoice is the record of what AP received. Rewriting it would make the
    // record disagree with the document, which is worse than the document being stale.
    return NextResponse.json({
      ok: false,
      message: `${inv.invoice_number} is already ${inv.status}, so it is a record of what was sent. Void and reissue it if the details have to change.`
    }, { status: 409 })
  }

  const { data: bamRows, error: bamErr } = await db.from('bams')
    .select('first_name, last_name, email, phone, street, city, prov, postal, bank_name')
    .eq('id', inv.bam_id)
  if (bamErr) {
    return NextResponse.json({ ok: false, message: `Could not read the roster row: ${bamErr.message}` }, { status: 500 })
  }
  const bam = (bamRows ?? [])[0] as Record<string, string | null> | undefined
  if (!bam) {
    return NextResponse.json({ ok: false, message: 'This invoice has no roster row. Tell your developer.' }, { status: 409 })
  }

  // Banking: read it, and carry on without it if it cannot be decrypted. The address
  // half of this repair is still worth doing, and batch-approve refuses to send an
  // invoice whose banking disagrees with the roster anyway, so a skip here cannot
  // become a wrong payment.
  const banking = await db.rpc('decrypt_bam_banking', { p_bam_id: inv.bam_id })
  const bk = (Array.isArray(banking.data) ? banking.data[0] : banking.data) as
    { institution_no?: string | null; transit_no?: string | null; account_no?: string | null } | null
  const bankingNote = banking.error
    ? `The banking could not be read (${banking.error.message}), so only the name and address were checked.`
    : null

  const refreshed = await refreshOpenInvoices(db, inv.bam_id, {
    firstName: bam.first_name,
    lastName: bam.last_name,
    email: bam.email,
    phone: bam.phone,
    street: bam.street,
    city: bam.city,
    prov: bam.prov,
    postal: bam.postal,
    ...(bk && !banking.error ? {
      bankName: bam.bank_name,
      institutionNo: bk.institution_no,
      transitNo: bk.transit_no,
      accountNo: bk.account_no
    } : {})
  }, invoiceId)

  const alreadyCurrent = refreshed.ok && refreshed.notes.length === 0

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'invoices',
    entity_id: invoiceId,
    action: 'roster_sync',
    before_json: null,
    // Field NAMES only. The values are the BAM's address and account number and this
    // table is read by more people than either of those should be.
    after_json: { invoice_number: inv.invoice_number, result: refreshed.notes, already_current: alreadyCurrent }
  })

  return NextResponse.json({
    ok: refreshed.ok,
    already_current: alreadyCurrent,
    audit_logged: !auditErr,
    message: alreadyCurrent
      ? `${inv.invoice_number} already matches the roster. Nothing was changed.`
      : [...refreshed.notes, bankingNote].filter(Boolean).join(' ')
  })
}
