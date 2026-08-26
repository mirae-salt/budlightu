/**
 * Recompute and store one BAM's reimbursement_ledger row for one period.
 *
 * WHY THIS FILE EXISTS
 *
 * reimbursement_ledger.paid_cad is the only number the rest of the system trusts for
 * money: the admin dashboard's spend figure reads it (app/api/admin/data), and
 * lib/invoice-ledger reads it to put an amount on an invoice. Nothing else is allowed
 * to re-derive that figure (P0-D, audit 2026-08-07).
 *
 * Until now that row was written ONLY by an admin decision (/api/admin/receipts/decide,
 * /api/admin/receipts/revert) or by the monthly sweep (scheduler-audit). A receipt the
 * classifier AUTO-PASSES goes through none of those, so it produced:
 *
 *   - a dashboard reading $0 while approved spend sat in the receipts table, and
 *   - no draft invoice at all, because lib/draft-invoice refuses to invoice a period
 *     whose ledger has not been computed (`ledger_pending`) rather than guess an amount.
 *
 * Observed 2026-08-26 with scripts/probe/autopass-ledger-gap.js: one auto_pass receipt
 * worth $69.00, no ledger row, no invoice, dashboard $0. Two symptoms, one hole.
 *
 * THE ONLY COPY
 *
 * This calculation used to exist four times: inline in receipts/decide, again in
 * receipts/revert, again in scheduler-audit, and here. Four copies of one payment rule
 * is four chances to disagree, and they already had. receipts/revert passed
 * `monthsActiveThroughPeriod: 1` and `priorLedger: []`, hardcoded, so it computed every
 * reversal as though it were the BAM's first month in the program. Under forfeit, which
 * is every cohort today, that happened to reach the same dollar figure, but it stored a
 * different cap_snapshot_cad and would have paid differently the moment a cohort was
 * switched to accumulate. A reimbursement that depends on which button was pressed last
 * is not one anybody can audit.
 *
 * All four now call this function, and computeMonthlyReimbursement is called from
 * exactly one place in the codebase. Where the copies disagreed, the strictest
 * behaviour won: an unusable rollover_mode refuses rather than defaulting, which is
 * what scheduler-audit alone used to do.
 *
 * Verified on the real ledger with scripts/probe/ledger-consolidation-check.js: every
 * existing row re-derived through this function, all nine money columns identical.
 *
 * FAIL CLOSED
 *
 * Every read is inspected (supabase-js does not throw), an unreadable cohort never
 * falls back to the default $150, and the write is read back before it is called a
 * success. A caller that could not store the money must not report it as settled.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */
import { computeMonthlyReimbursement } from './reimbursement'
import { DEFAULT_POLICY, shortfallWarnBelow } from './policy'
import { parseNonNegativeMoney } from './money'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LedgerDb = { from: (...args: any[]) => any }

/** Receipt states whose amounts count as spend for the month. */
export const SPENT_RECEIPT_STATES: string[] = ['approved', 'auto_pass']

export type RecomputeLedgerResult =
  | {
      ok: true
      /** What the BAM is paid for this period. The authoritative figure. */
      paidCad: number
      /** Sum of every approved/auto_pass receipt in the period. */
      spentCad: number
      /** The month's full allowance, before anything is spent. */
      entitlementCad: number
      /**
       * The LEDGER's shortfall column: spend came in under the full entitlement.
       *
       * Not the same thing as belowWarnFloor, and the two are easy to confuse, which
       * is why they are named apart. This one is true at $149 of a $150 entitlement.
       */
      shortfallFlag: boolean
      /** Spend below this is worth telling someone about. $130, Robin 2026-08-14. */
      shortfallWarnBelowCad: number
      /** True when spentCad is under THAT floor. This is the one that raises a warning. */
      belowWarnFloor: boolean
      /** True when no row existed for this period before the call. */
      created: boolean
    }
  | { ok: false; error: string }

/**
 * Reads the cohort policy, sums the period's receipts, and upserts the ledger row.
 *
 * Idempotent: the upsert is keyed on (bam_id, cohort_id, period) and the amount is
 * always recomputed from the full set of receipts, never incremented. Calling it twice
 * for one period produces the same row, which is what makes it safe to run on every
 * auto-pass as well as from the monthly sweep.
 */
export async function recomputeLedgerForPeriod(
  db: LedgerDb,
  args: { bamId: string; cohortId: string; period: string }
): Promise<RecomputeLedgerResult> {
  const { bamId, cohortId, period } = args

  // 1. Cohort policy. An unreadable cohort must NOT become "default policy": a cohort
  //    capped at $100 would otherwise quietly be paid the $150 default.
  const { data: cohort, error: cohortErr } = await db.from('cohorts')
    .select('reimbursement_max, rollover_mode, cap_multiplier')
    .eq('id', cohortId)
    .maybeSingle()
  if (cohortErr || !cohort) {
    return { ok: false, error: `cohort policy could not be read (${cohortErr?.message ?? 'no cohort row'})` }
  }
  const cohortMax = parseNonNegativeMoney(cohort.reimbursement_max)
  const cohortMultiplier = Number(cohort.cap_multiplier)
  if (cohortMax === null || cohortMax <= 0 || !Number.isFinite(cohortMultiplier) || cohortMultiplier <= 0) {
    return {
      ok: false,
      error: `cohort reimbursement_max="${String(cohort.reimbursement_max)}" ` +
             `cap_multiplier="${String(cohort.cap_multiplier)}" is not a usable number`
    }
  }

  /*
   * rollover_mode is checked against the two legal values rather than defaulted.
   *
   * computeMonthlyReimbursement treats anything that is not the string 'forfeit' as
   * accumulate, so a typo in that column would silently switch a cohort into carrying
   * money forward. scheduler-audit already refused to run on an unusable value and
   * skipped the whole cohort; the other callers defaulted instead. This function is the
   * one all of them use now, so it takes the stricter of the two behaviours. A cohort we
   * cannot read a policy for is a cohort we do not pay.
   */
  const rolloverMode = cohort.rollover_mode
  if (rolloverMode !== 'forfeit' && rolloverMode !== 'accumulate') {
    return { ok: false, error: `cohort rollover_mode is "${String(rolloverMode)}", which is neither forfeit nor accumulate` }
  }

  const policy = {
    ...DEFAULT_POLICY,
    reimbursementMax: cohortMax,
    rolloverMode: rolloverMode as 'accumulate' | 'forfeit',
    capMultiplier: cohortMultiplier,
    // Classifier-only flag. It decides whether a receipt reaches a human and has
    // nothing to say about ledger arithmetic.
    firstCohortAllReview: false
  }

  // 2. The whole month, not just the receipt that triggered this. A BAM may submit
  //    several, and the ledger describes the period.
  const { data: monthReceipts, error: monthErr } = await db.from('receipts')
    .select('bud_light_total_incl_tax, status')
    .eq('bam_id', bamId)
    .eq('period', period)
    .in('status', SPENT_RECEIPT_STATES)
  if (monthErr) {
    return { ok: false, error: `this period's receipts could not be summed (${monthErr.message})` }
  }
  let spentCad = 0
  for (const r of monthReceipts ?? []) {
    const v = parseNonNegativeMoney((r as { bud_light_total_incl_tax: unknown }).bud_light_total_incl_tax)
    if (v !== null) spentCad = Math.round((spentCad + v) * 100) / 100
  }

  // 3. Prior months, for rollover and for how long this BAM has been active.
  const { data: prior, error: priorErr } = await db.from('reimbursement_ledger')
    .select('*')
    .eq('bam_id', bamId)
    .lt('period', period)
    .order('period', { ascending: true })
  if (priorErr) {
    return { ok: false, error: `prior ledger unreadable (${priorErr.message})` }
  }
  const priorLedger = (prior ?? []).map((p: Record<string, unknown>) => ({
    period: p.period as string,
    entitlementCad: Number(p.entitlement_cad),
    spentCad: Number(p.spent_cad),
    carryoverInCad: Number(p.carryover_in_cad),
    carryoverOutCad: Number(p.carryover_out_cad),
    paidCad: Number(p.paid_cad),
    spendableCapCad: Number(p.spendable_cap_cad),
    capSnapshotCad: Number(p.cap_snapshot_cad),
    shortfallFlag: p.shortfall_flag as boolean,
    policyVersion: p.policy_version as number
  }))

  const out = computeMonthlyReimbursement({
    period,
    monthsActiveThroughPeriod: priorLedger.length + 1,
    receiptsTotalInclHst: spentCad,
    priorLedger,
    policy
  })

  // Did a row already exist? Asked before the upsert purely so the caller can say
  // "recorded" rather than "recorded again" without another round trip.
  const { data: existingRows, error: existingErr } = await db.from('reimbursement_ledger')
    .select('id')
    .eq('bam_id', bamId)
    .eq('cohort_id', cohortId)
    .eq('period', period)
  if (existingErr) {
    return { ok: false, error: `existing ledger row could not be checked (${existingErr.message})` }
  }
  const created = (existingRows ?? []).length === 0

  // 4. The write that decides what the BAM is paid.
  const { data: ledgerRows, error: ledgerErr } = await db.from('reimbursement_ledger').upsert({
    bam_id: bamId,
    cohort_id: cohortId,
    period,
    entitlement_cad: out.entitlement,
    spent_cad: spentCad,
    carryover_in_cad: out.carryoverIn,
    carryover_out_cad: out.carryoverOut,
    paid_cad: out.paidThisMonth,
    spendable_cap_cad: out.spendableCap,
    cap_snapshot_cad: out.capSnapshot,
    shortfall_flag: out.shortfallFlag,
    policy_version: policy.policyVersion,
    created_by: 'system'
  }, { onConflict: 'bam_id,cohort_id,period' })
    .select('id, paid_cad, spent_cad')

  if (ledgerErr) {
    return { ok: false, error: `reimbursement ledger write failed (${ledgerErr.message})` }
  }
  if (!ledgerRows || ledgerRows.length !== 1) {
    return { ok: false, error: `reimbursement ledger write affected ${ledgerRows?.length ?? 0} rows, expected 1` }
  }

  // 5. Read-back (ENGINEERING-RULES 1). A write that reported success and stored a
  //    different number is the failure this whole file exists to catch.
  const persistedPaid = parseNonNegativeMoney(ledgerRows[0].paid_cad)
  if (persistedPaid === null || Math.abs(persistedPaid - out.paidThisMonth) > 0.005) {
    return {
      ok: false,
      error: `ledger read-back mismatch: stored $${String(ledgerRows[0].paid_cad)}, ` +
             `expected $${out.paidThisMonth.toFixed(2)}`
    }
  }

  const warnBelow = shortfallWarnBelow(policy)
  return {
    ok: true,
    paidCad: persistedPaid,
    spentCad,
    entitlementCad: out.entitlement,
    shortfallFlag: out.shortfallFlag,
    shortfallWarnBelowCad: warnBelow,
    belowWarnFloor: spentCad < warnBelow,
    created
  }
}
