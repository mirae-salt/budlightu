/**
 * Gives a BAM an invoice for a period before they have submitted anything.
 *
 * Janet, 2026-09-04: "Can all BAMs appear in the invoicing section, even if they have
 * not yet submitted a receipt? Right now the only BAMs whose invoices I can edit are
 * ones who have submitted receipts ... hoping we can have them all there at the start of
 * each month so Robin or I can edit invoices for bar tabs and other expenses."
 *
 * An invoice needs a reimbursement_ledger row, because the amount on it comes from the
 * ledger and nowhere else (P0-D). No receipts meant no ledger row, which meant no
 * invoice, which meant nothing to add a line to.
 *
 * So the ledger row is written first, at zero. That is not a placeholder: a student who
 * has spent nothing has spent zero, and the row says so. It is computed by the same
 * recomputeLedgerForPeriod every other path uses, rather than inserted by hand, so the
 * cap and the shortfall flag are decided in one place as always. When their first
 * receipt lands, that same function raises the figure and the draft invoice picks it up.
 *
 * WHY ONLY ACTIVE BAMs
 *
 * generateInvoicePayload hard-blocks on missing banking (P0-E) and nothing re-checks it
 * at send time, so an invoice built without banking could be approved and reach AP as a
 * payment instruction with no account on it. A BAM who has not finished onboarding has
 * no banking, cannot be paid this month either way, and gets their invoice the moment
 * they finish.
 */
import { recomputeLedgerForPeriod, type LedgerDb } from './recompute-ledger'
import { upsertDraftInvoice } from './draft-invoice'

export type SeedResult =
  | { ok: true; created: boolean; paidCad: number; invoiceNumber?: string }
  | { ok: false; reason: string }

type SeedDb = LedgerDb & Parameters<typeof upsertDraftInvoice>[0]

/**
 * Idempotent. Called again for a BAM who already has a ledger row and an invoice, it
 * recomputes the same figures and rewrites the same draft, which is what makes it safe
 * to run from a monthly job and from onboarding without coordinating the two.
 */
export async function seedPeriodInvoice(
  db: SeedDb,
  args: { bamId: string; cohortId: string; period: string }
): Promise<SeedResult> {
  const ledger = await recomputeLedgerForPeriod(db, args)
  if (!ledger.ok) return { ok: false, reason: `ledger: ${ledger.error}` }

  const invoice = await upsertDraftInvoice(db, args.bamId, args.cohortId, args.period, {
    // A missing ledger row is the one thing that cannot be true here: we just wrote it.
    quietWhenLedgerPending: false
  })
  if (!invoice.ok) return { ok: false, reason: invoice.reason }

  return {
    ok: true,
    created: ledger.created,
    paidCad: ledger.paidCad,
    invoiceNumber: (invoice as { invoiceNumber?: string }).invoiceNumber
  }
}

/** The first of the month a date falls in, as the `period` column stores it. */
export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`
}
