/**
 * Reimbursement + rollover ledger computation (pure function).
 * Contract from ARCHITECTURE.md §A.3.
 *
 * Key rules:
 *   • Reimburse actual spend up to `reimbursement_max` (default $150).
 *   • Unspent amount rolls forward (accumulate) unless mode=forfeit.
 *   • Cumulative cap = cap_multiplier × months_active × reimbursement_max.
 *   • Salary is independent (handled by invoice-engine; not here).
 *   • Total is measured incl. HST (caller sums that way).
 */

export type Policy = {
  reimbursementMax: number      // e.g. 150
  rolloverMode: 'accumulate' | 'forfeit'
  capMultiplier: number         // usually 1
  reviewBandPaddingUsd: number  // usually 10
  firstCohortAllReview: boolean
  policyVersion: number
}

export type LedgerRow = {
  period: string                // ISO date "YYYY-MM-01"
  entitlementUsd: number
  spentUsd: number
  carryoverInUsd: number
  carryoverOutUsd: number
  paidUsd: number
  spendableCapUsd: number
  capSnapshotUsd: number
  shortfallFlag: boolean
  policyVersion: number
}

export type ComputeInput = {
  period: string                        // "YYYY-MM-01"
  monthsActiveThroughPeriod: number     // e.g. 3rd month of the cohort → 3
  receiptsTotalInclHst: number          // sum of APPROVED receipts only
  priorLedger: LedgerRow[]              // ordered ascending, up to last 12 months
  policy: Policy
}

export type ComputeOutput = {
  entitlement: number
  carryoverIn: number
  spendableCap: number
  paidThisMonth: number
  carryoverOut: number
  shortfallFlag: boolean
  capSnapshot: number
  reasons: string[]
}

export function computeMonthlyReimbursement(input: ComputeInput): ComputeOutput {
  const { period, monthsActiveThroughPeriod, receiptsTotalInclHst, priorLedger, policy } = input
  const reasons: string[] = []

  if (!Number.isFinite(receiptsTotalInclHst) || receiptsTotalInclHst < 0) {
    throw new Error(`receiptsTotalInclHst must be non-negative finite, got ${receiptsTotalInclHst}`)
  }
  if (monthsActiveThroughPeriod < 1) {
    throw new Error(`monthsActiveThroughPeriod must be >=1, got ${monthsActiveThroughPeriod}`)
  }

  const entitlement = policy.reimbursementMax
  reasons.push(`entitlement=${entitlement}`)

  // carryoverIn = previous ledger's carryoverOut (0 if none, or if last row was written under forfeit)
  const last = priorLedger.length ? priorLedger[priorLedger.length - 1] : null
  const carryoverIn = last ? last.carryoverOutUsd : 0
  if (carryoverIn > 0) reasons.push(`carryover_in=${carryoverIn}`)

  const spendableCap = round2(entitlement + carryoverIn)
  reasons.push(`spendable_cap=${spendableCap}`)

  // Cumulative cap (across the program) = cap_multiplier × months_active × max
  const capSnapshot = round2(policy.capMultiplier * monthsActiveThroughPeriod * policy.reimbursementMax)
  reasons.push(`cap_snapshot=${capSnapshot}`)

  // Paid this month = min(spent, spendable_cap) — bounded further by capSnapshot on the whole-program view
  // (spendableCap already respects entitlement + carryover; capSnapshot is a program-wide safety net)
  const paidThisMonth = round2(Math.min(receiptsTotalInclHst, spendableCap, capSnapshot))
  reasons.push(`paid_this_month=${paidThisMonth}`)

  // Carryover out = what's left of spendableCap after this month's payment
  // forfeit mode: never carry
  const carryoverOut =
    policy.rolloverMode === 'forfeit'
      ? 0
      : round2(Math.max(0, spendableCap - paidThisMonth))
  if (policy.rolloverMode === 'forfeit') {
    reasons.push('forfeit: carryover_out=0')
  } else {
    reasons.push(`carryover_out=${carryoverOut}`)
  }

  const shortfallFlag = receiptsTotalInclHst < entitlement
  if (shortfallFlag) reasons.push(`shortfall (spent ${receiptsTotalInclHst} < entitlement ${entitlement})`)

  return {
    entitlement,
    carryoverIn,
    spendableCap,
    paidThisMonth,
    carryoverOut,
    shortfallFlag,
    capSnapshot,
    reasons
  }
}

/**
 * P0-2 fix: REVIEW-band boundary check for a single receipt total against BOTH
 *   • the rolling spendable cap (entitlement + carryover_in) and
 *   • the fresh monthly max.
 * Returns true if the total falls within the padding band of either boundary
 * (so classifier should force REVIEW instead of auto-pass).
 */
export function isInReviewBand(
  totalInclHst: number,
  spendableCap: number,
  reimbursementMax: number,
  paddingUsd: number
): boolean {
  const inRollingBand =
    totalInclHst >= spendableCap - paddingUsd && totalInclHst <= spendableCap + paddingUsd
  const inFreshBand =
    totalInclHst >= reimbursementMax - paddingUsd && totalInclHst <= reimbursementMax + paddingUsd
  return inRollingBand || inFreshBand
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
