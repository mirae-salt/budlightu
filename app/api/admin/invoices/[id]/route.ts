/**
 * PATCH /api/admin/invoices/[id]   { lines: [...], reason: "..." }
 *
 * Robin's in-app correction of the SALARY line and the AD-HOC lines (bar tab,
 * gas, event costs). Neither is automated: ad-hoc adjustments are excluded from
 * the monthly generator by design (CLAUDE.md), and the salary line occasionally
 * needs a one-off fix.
 *
 * What this route does NOT do:
 *  - it does not touch the REIMBURSEMENT line. That number lives on the receipt
 *    (/admin/receipts, override the receipt total) and flows
 *    receipt -> reimbursement_ledger.paid_cad -> invoice. `payloadLedgerMismatch`
 *    hard-blocks the AP send when the invoice disagrees with the ledger, and that
 *    check is the last thing standing between a wrong number and a real payment.
 *    Editing the reimbursement line here is refused, not "handled".
 *  - it does not trust any client-sent subtotal / tax / total. All three are
 *    recomputed from the submitted lines with the generator's own helpers.
 *  - it does not decrypt banking. Whether tax applies is resolved from a
 *    `hst_number is not null` filter, so the ciphertext is never even fetched and
 *    `decrypt_bam_banking` is never called.
 *
 * All the logic lives in lib/invoice-lines.ts so it is unit tested without a
 * database and stays reusable from an Edge Function if the stack changes. This
 * file is auth + input plumbing.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import { applyInvoiceLineEdit } from '../../../../../lib/invoice-lines'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const { id } = await ctx.params
  if (!id) return NextResponse.json({ ok: false, message: 'Invoice id is required.' }, { status: 400 })
  // Shape-checked here so a malformed id is a 400, not a 500 carrying a raw
  // Postgres "invalid input syntax for type uuid" string.
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, message: 'That is not a valid invoice id.' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body.' }, { status: 400 })
  }
  const fields = (body ?? {}) as Record<string, unknown>

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  // The BAM's province (tax rate) and whether an HST number exists. Two facts,
  // fetched separately on purpose:
  //  - `prov` is a plain column.
  //  - `hst_number` is ciphertext (0003_encryption_pgsodium.sql). The filtered
  //    query below returns only the id, so the value never enters this process.
  const { data: invRows, error: invErr } = await db
    .from('invoices')
    .select('id, bam_id, bams(prov)')
    .eq('id', id)
  if (invErr) {
    return NextResponse.json({ ok: false, message: `Could not read the invoice: ${invErr.message}` }, { status: 500 })
  }
  const invRow = (invRows ?? [])[0] as
    | { id: string; bam_id: string; bams?: { prov?: string | null } | Array<{ prov?: string | null }> | null }
    | undefined
  if (!invRow) {
    return NextResponse.json({ ok: false, message: 'That invoice does not exist. Reload the page.' }, { status: 404 })
  }
  // supabase-js types an embedded one-to-one relation as an array.
  const bamRel = Array.isArray(invRow.bams) ? invRow.bams[0] : invRow.bams
  const province = bamRel?.prov ?? ''

  const { data: hstRows, error: hstErr } = await db
    .from('bams')
    .select('id')
    .eq('id', invRow.bam_id)
    .not('hst_number', 'is', null)
  if (hstErr) {
    // Fail CLOSED. Guessing here would either invent or drop tax on a payment
    // document (ENGINEERING-RULES 7.5).
    return NextResponse.json(
      { ok: false, message: `Could not confirm whether this BAM charges HST (${hstErr.message}). Nothing was changed.` },
      { status: 500 }
    )
  }
  const hstOnFile = (hstRows ?? []).length > 0

  const result = await applyInvoiceLineEdit(db, {
    invoiceId: id,
    lines: fields.lines,
    reason: fields.reason,
    actor: { userId: auth.devBypass ? null : auth.userId, role: auth.role },
    hstOnFile,
    province
  })

  if (!result.ok) {
    return NextResponse.json({ ok: false, message: result.message }, { status: result.status })
  }

  return NextResponse.json({
    ok: true,
    invoice_id: result.invoiceId,
    invoice_number: result.invoiceNumber,
    status: result.status,
    lines: result.lines,
    subtotal: result.subtotal,
    tax: result.tax,
    total: result.total,
    pdf_invalidated: result.pdfInvalidated,
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {})
  })
}
