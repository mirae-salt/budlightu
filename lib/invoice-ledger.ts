/**
 * Single source of truth for the reimbursement dollar figure on an invoice
 * (P0-D, audit 2026-08-07 · ENGINEERING-RULES §7.2).
 *
 * Before this module lib/draft-invoice.ts re-derived the amount itself with
 * `Math.min(sum(receipts), 150)`: a hardcoded cap that ignored the cohort's
 * reimbursement_max and the whole policy engine, while reimbursement_ledger
 * held a different number computed by computeMonthlyReimbursement. AP was
 * being sent the re-derived figure.
 *
 * Rule now: the amount comes from reimbursement_ledger.paid_cad, period.
 * Nothing here recomputes or caps anything.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LedgerDbClient = { from: (...args: any[]) => any }

/**
 * Machine-readable failure kinds so callers can tell "this month has not been
 * computed yet" (an ordinary, expected state during the upload window) apart from
 * "something is actually wrong". Critic gate F5: without this distinction every
 * single receipt upload raised a "Invoice generation blocked" admin notification,
 * roughly 150 false alarms a month at 58 BAMs, in the same queue as the genuine
 * blocks (missing banking, missing PO). Alert fatigue on the one notification
 * that has to be believed.
 */
export type ReimbursementLookupFailure =
  /** Ledger row for this (bam, cohort, period) does not exist yet, but receipts do. */
  | 'ledger_pending'
  /** Read error, ambiguous duplicate rows, or an unusable paid_cad. */
  | 'unreadable'

export type ReimbursementLookup
  = | { ok: true; paidCad: number; source: 'ledger' | 'no_receipts' }
    | { ok: false; error: string; failure: ReimbursementLookupFailure }

/** Receipt states that mean "money for this month is still in play". */
const RECEIPT_STATES_WITH_MONEY = ['pending', 'auto_pass', 'review', 'approved']

/**
 * Reads the ledger amount for (bam, cohort, period).
 *
 * Fail-closed rules:
 *  - a DB error is never treated as "no reimbursement" (supabase-js does not throw)
 *  - more than one ledger row for the key = refuse rather than pick one
 *  - no ledger row BUT receipts exist for the month = refuse. The ledger has not
 *    been computed yet, so invoicing now would silently drop money owed.
 *  - no ledger row and no receipts = a legitimate salary-only month, 0.
 */
export async function lookupReimbursement(
  db: LedgerDbClient,
  bamId: string,
  cohortId: string,
  period: string
): Promise<ReimbursementLookup> {
  const { data: rows, error } = await db
    .from('reimbursement_ledger')
    .select('paid_cad')
    .eq('bam_id', bamId)
    .eq('cohort_id', cohortId)
    .eq('period', period)

  if (error) {
    return { ok: false, failure: 'unreadable', error: `reimbursement_ledger read failed: ${error.message}` }
  }

  const ledgerRows: Array<{ paid_cad: unknown }> = rows ?? []
  if (ledgerRows.length > 1) {
    return {
      ok: false,
      failure: 'unreadable',
      error: `${ledgerRows.length} reimbursement_ledger rows for bam ${bamId} / period ${period} — refusing to guess which amount is real`
    }
  }

  if (ledgerRows.length === 1) {
    const paidCad = Number(ledgerRows[0].paid_cad)
    if (!Number.isFinite(paidCad) || paidCad < 0) {
      return {
        ok: false,
        failure: 'unreadable',
        error: `reimbursement_ledger.paid_cad is not a usable amount: ${JSON.stringify(ledgerRows[0].paid_cad)}`
      }
    }
    return { ok: true, paidCad: round2(paidCad), source: 'ledger' }
  }

  // No ledger row — is that because there is genuinely nothing to reimburse?
  const { data: receiptRows, error: rErr } = await db
    .from('receipts')
    .select('id')
    .eq('bam_id', bamId)
    .eq('period', period)
    .in('status', RECEIPT_STATES_WITH_MONEY)
    .limit(1)

  if (rErr) {
    return {
      ok: false,
      failure: 'unreadable',
      error: `receipts read failed while checking for a missing ledger row: ${rErr.message}`
    }
  }

  if ((receiptRows ?? []).length > 0) {
    return {
      ok: false,
      failure: 'ledger_pending',
      error:
        `no reimbursement_ledger row for period ${period} but receipts exist — ` +
        `the ledger has not been computed yet. Invoice blocked so the BAM is not underpaid. ` +
        `Decide the receipts (touchpoint 1) or run the monthly audit, then regenerate.`
    }
  }

  return { ok: true, paidCad: 0, source: 'no_receipts' }
}

/**
 * States where a receipt still owes a decision AND the ledger does not yet reflect it.
 *
 * Derived from RECEIPT_STATES_WITH_MONEY above by removing 'approved', which is the only one
 * of them that has been settled into reimbursement_ledger. 'rejected' is decided and worth
 * nothing. 'ocr_failed' is deliberately absent, matching the existing policy that it is
 * excluded from shortfall judgement and handled through the review queue and retry: it can
 * stay unreadable indefinitely, and a receipt nobody can decide must not block a payment
 * forever.
 */
const RECEIPT_STATES_UNDECIDED = ['pending', 'auto_pass', 'review']

/**
 * Refuse to SEND an invoice while a receipt for that month is still waiting on a decision.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT IN lookupReimbursement
 * ---------------------------------------------------------
 * lookupReimbursement already refuses when there is NO ledger row but receipts exist, with the
 * comment "Invoice blocked so the BAM is not underpaid". That guard has a hole: once a ledger
 * row exists it returns immediately and never looks at receipts again. A row saying
 * `paid_cad = 0` is a ledger row.
 *
 * Found 2026-08-13, from a real case. A receipt for $58.45 was approved, then reverted, which
 * recomputed the ledger to $0 and left the receipt in 'review'. Batch approve then reported
 * success on an invoice carrying no reimbursement at all, while $58.45 of that student's money
 * was still sitting in Robin's queue undecided. On a live cohort that invoice reaches AP as
 * final, on net-15 terms, and the student is simply short for the month.
 *
 * This is the failure the 16th/17th split exists to prevent: audit on the 16th so Robin has a
 * day to clear flagged receipts before invoices generate on the 17th. Nothing enforced that she
 * had. Now the send does.
 *
 * NOT in lookupReimbursement because lib/draft-invoice.ts and generateInvoicePayload call it
 * too, and drafts must keep generating all month while receipts are still being reviewed.
 * Blocking there would break the thing this is trying to protect. So it sits beside
 * payloadLedgerMismatch and is called from the three places that actually send.
 *
 * Fails CLOSED on a read error, like everything else in this file: if we cannot tell whether a
 * decision is outstanding, we do not send money.
 *
 * Returns null when it is safe to send, or the reason when it is not.
 */
export async function undecidedReceiptsProblem(
  db: LedgerDbClient,
  bamId: string,
  period: string
): Promise<string | null> {
  const { data, error } = await db
    .from('receipts')
    .select('id, status')
    .eq('bam_id', bamId)
    .eq('period', period)
    .in('status', RECEIPT_STATES_UNDECIDED)

  if (error) {
    return `could not check whether any receipt is still under review (${error.message}) — refusing to send rather than risk underpaying`
  }

  const rows = (data ?? []) as Array<{ status: string }>
  if (rows.length === 0) return null

  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  const breakdown = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(', ')

  return (
    `HARD BLOCK · ${rows.length} receipt(s) for this month have not been decided yet (${breakdown}). ` +
    `Sending now would invoice this BAM without money they may be owed, and the invoice is final ` +
    `once AP has it. Clear them on the Receipts page (touchpoint 1), then send.`
  )
}

// ── pure payload/ledger reconciliation (used at send time) ───────────────────

export type PayloadLineish = { description?: unknown; total?: unknown }

/** Matches the reimbursement line generated by lib/invoice-payload.ts. */
export function reimbursementLineTotal(lines: PayloadLineish[] | undefined | null): number {
  let sum = 0
  for (const l of lines ?? []) {
    if (typeof l?.description === 'string' && /reimbursement/i.test(l.description)) {
      sum += Number(l.total ?? 0)
    }
  }
  return round2(sum)
}

/**
 * HARD BLOCK before any AP send: the amount on the document AP will pay from
 * must equal the ledger. Returns an error string, or null when they agree.
 */
export function payloadLedgerMismatch(
  lines: PayloadLineish[] | undefined | null,
  ledgerPaidCad: number
): string | null {
  const onInvoice = reimbursementLineTotal(lines)
  const inLedger = round2(Number(ledgerPaidCad))
  if (!Number.isFinite(inLedger)) {
    return `ledger amount is not a number (${JSON.stringify(ledgerPaidCad)}) — refusing to send`
  }
  if (onInvoice !== inLedger) {
    return (
      `HARD BLOCK · reimbursement on invoice ($${onInvoice.toFixed(2)}) does not match ` +
      `reimbursement_ledger.paid_cad ($${inLedger.toFixed(2)}). ` +
      `Regenerate the invoice from the ledger before sending.`
    )
  }
  return null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
