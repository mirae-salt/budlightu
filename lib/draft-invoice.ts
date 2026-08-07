/**
 * Draft invoice upsert, called after a receipt decision.
 *
 * Rewritten for AUDIT-2026-08-07:
 *  - P0-D: the reimbursement amount is read from reimbursement_ledger.paid_cad.
 *    It is no longer re-derived as `Math.min(sum(receipts), 150)`, which ignored
 *    the cohort's reimbursement_max and disagreed with the ledger AP is audited
 *    against. There is no hardcoded 150 in this file any more.
 *  - P0-E: banking is mandatory. The old code destructured only `data` from five
 *    calls (including decrypt_bam_banking), then on failure built
 *    directDeposit:{bank:'',institutionNumber:'',…} and inserted it as a draft,
 *    which was eligible for batch-approve → PDF → AP with no flag anywhere.
 *    The whole blank-banking fallback branch is gone.
 *  - P0-H: every supabase `error` is inspected. supabase-js does not throw.
 *  - P1-8: the second, divergent initials derivation (`${first[0]}${last[0]}`,
 *    which produced "AUNDEFINED" for an empty last name and shipped
 *    INV-AUNDEFINED1) is gone. Initials come from ensureInitialsResolved.
 *  - P1-22: seq/revision come from resolveSeqAndRevision, so a voided number is
 *    never recycled.
 *
 * Failure is always visible: console.error + an admin notification. Nothing is
 * written when any input is uncertain.
 */
import { generateInvoicePayload } from './invoice-payload'
import { ensureInitialsResolved } from './ensure-initials'
import { lookupReimbursement } from './invoice-ledger'
import { resolveSeqAndRevision } from './invoice-sequence'
import { notifyAdmin } from './notify-admin'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = { from: (...args: any[]) => any; rpc: (...args: any[]) => any }

export type UpsertDraftInvoiceResult =
  | { ok: true; invoiceId: string; invoiceNumber: string; created: boolean; reimbursementCad: number }
  | { ok: false; blocked: true; reason: string }

export async function upsertDraftInvoice(
  db: AdminClient,
  bamId: string,
  cohortId: string,
  period: string
): Promise<UpsertDraftInvoiceResult> {
  const block = async (reason: string): Promise<UpsertDraftInvoiceResult> => {
    console.error(`[draft-invoice] BLOCKED bam=${bamId} cohort=${cohortId} period=${period}: ${reason}`)
    await notifyAdmin({
      type: 'invoice_draft',
      title: 'Invoice generation blocked',
      body: reason,
      bam_id: bamId,
      cohort_id: cohortId,
      period,
      link: '/admin/invoices'
    })
    return { ok: false, blocked: true, reason }
  }

  // ── 1. inputs. Every error inspected; arrays instead of maybeSingle() ──────
  const [bamRes, cohortRes, bankingRes] = await Promise.all([
    db.from('bams')
      .select('id, first_name, last_name, email, phone, street, city, prov, postal, bank_name, initials_resolved, cohort_id')
      .eq('id', bamId),
    db.from('cohorts')
      .select('id, program_label, po_number, salary_default')
      .eq('id', cohortId),
    db.rpc('decrypt_bam_banking', { p_bam_id: bamId })
  ])

  if (bamRes.error) return block(`bams read failed: ${bamRes.error.message}`)
  if (cohortRes.error) return block(`cohorts read failed: ${cohortRes.error.message}`)
  if (bankingRes.error) return block(`decrypt_bam_banking failed: ${bankingRes.error.message}`)

  const bam = (bamRes.data ?? [])[0]
  const cohort = (cohortRes.data ?? [])[0]
  if (!bam) return block(`bam ${bamId} not found`)
  if (!cohort) return block(`cohort ${cohortId} not found`)
  if (bam.cohort_id !== cohortId) {
    return block(`bam ${bamId} belongs to cohort ${bam.cohort_id}, not ${cohortId} — refusing to invoice across cohorts`)
  }
  if (!cohort.po_number) {
    return block('cohort.po_number is not set — HARD BLOCK, confirm the PO before generating invoices')
  }
  const salaryDefault = Number(cohort.salary_default)
  if (!Number.isFinite(salaryDefault) || salaryDefault <= 0) {
    return block(`cohort.salary_default is not a usable amount (${JSON.stringify(cohort.salary_default)})`)
  }

  // ── 2. banking is mandatory (P0-E) ────────────────────────────────────────
  const bankingRow = Array.isArray(bankingRes.data) ? bankingRes.data[0] : bankingRes.data
  const banking = bankingRow as Record<string, string> | null | undefined
  if (!banking || !banking.institution_no || !banking.transit_no || !banking.account_no) {
    return block(
      'banking details are missing or could not be decrypted — invoice NOT created. ' +
      'A blank direct-deposit block must never reach AP. Have the BAM complete onboarding.'
    )
  }

  // ── 3. money comes from the ledger only (P0-D) ────────────────────────────
  const ledger = await lookupReimbursement(db, bamId, cohortId, period)
  if (!ledger.ok) return block(ledger.error)

  // ── 4. initials (P1-8 / P1-11) ────────────────────────────────────────────
  const initials = await ensureInitialsResolved(db, bamId, cohortId)
  if (!initials.ok) return block(initials.error)

  // ── 5. seq + revision (P1-22) ─────────────────────────────────────────────
  const sequence = await resolveSeqAndRevision(db, bamId, cohortId, period)
  if (!sequence.ok) return block(sequence.error)
  if (sequence.existingStatus && sequence.existingStatus !== 'draft') {
    return block(
      `invoice ${sequence.existingNumber ?? sequence.existingId} for this period is already ${sequence.existingStatus} — ` +
      'not rewriting a document AP may already hold. Void it first if it needs to change.'
    )
  }

  // ── 6. payload (validates institution/transit/account, throws on bad data) ─
  let payload
  try {
    payload = generateInvoicePayload({
      bam: {
        firstName: bam.first_name,
        lastName: bam.last_name,
        street: bam.street ?? '',
        city: bam.city ?? '',
        prov: bam.prov ?? '',
        postal: bam.postal ?? '',
        email: bam.email,
        phone: bam.phone ?? '',
        bankName: bam.bank_name ?? '',
        institutionNo: banking.institution_no,
        transitNo: banking.transit_no,
        accountNo: banking.account_no,
        hstNumber: banking.hst_number,
        initialsResolved: initials.initials
      },
      cohort: {
        programLabel: cohort.program_label,
        poNumber: cohort.po_number,
        salaryDefault: salaryDefault,
        currency: 'CAD'
      },
      ledger: { paidCad: ledger.paidCad },
      period: new Date(period),
      seq: sequence.seq,
      revision: sequence.revision,
      generatedAt: new Date()
    })
  } catch (e) {
    return block(`payload generation failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ── 7. write. Errors surfaced — a swallowed invoice-number collision used to
  //      mean the BAM silently got no invoice that month. ─────────────────────
  if (sequence.existingId) {
    const { data: updated, error: updErr } = await db.from('invoices')
      .update({ payload_json: payload, invoice_number: payload.invoiceNumber, revision: sequence.revision })
      .eq('id', sequence.existingId)
      .eq('status', 'draft')
      .select('id')
    if (updErr) return block(`invoice update failed: ${updErr.message}`)
    if (!(updated ?? []).length) {
      return block(`invoice ${sequence.existingId} was no longer a draft when we tried to update it`)
    }
    return {
      ok: true,
      invoiceId: sequence.existingId,
      invoiceNumber: payload.invoiceNumber,
      created: false,
      reimbursementCad: ledger.paidCad
    }
  }

  const { data: inserted, error: insErr } = await db.from('invoices').insert({
    bam_id: bamId,
    cohort_id: cohortId,
    period,
    seq: sequence.seq,
    revision: sequence.revision,
    invoice_number: payload.invoiceNumber,
    payload_json: payload,
    status: 'draft',
    currency: 'CAD'
  }).select('id')

  if (insErr) return block(`invoice insert failed: ${insErr.message}`)
  const newId = (inserted ?? [])[0]?.id
  if (!newId) return block('invoice insert returned no row')

  return {
    ok: true,
    invoiceId: newId,
    invoiceNumber: payload.invoiceNumber,
    created: true,
    reimbursementCad: ledger.paidCad
  }
}
