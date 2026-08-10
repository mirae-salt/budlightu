/**
 * Policy shape + defaults. Materialized values live in the `policy` table
 * (see supabase/migrations/0006_seed_policy.sql) and can be overridden
 * per-cohort in the `cohorts` table.
 */

import type { Policy } from './reimbursement'

export const DEFAULT_POLICY: Policy = {
  reimbursementMax: 150,
  rolloverMode: 'forfeit',
  capMultiplier: 1,
  reviewBandPaddingCad: 10,
  // Review-everything mode is OFF (Mirae, 2026-08-10, stated repeatedly).
  //
  // The program exists to remove ~5 hours a month of manual checking. With this on,
  // all 58 BAMs x 8 months = 464 receipts each need a click from Robin, which is
  // the problem rather than the safeguard. A receipt should reach her only when
  // there is a real reason to flag it: no Bud Light lines found, low OCR
  // confidence, a duplicate, a total at or near the cap, or an amount the server
  // could not corroborate. Those checks all still run.
  //
  // Note this is only the DEFAULT. `cohorts.first_cohort_all_review` still wins,
  // so a future cohort can be put back into review-everything mode deliberately.
  firstCohortAllReview: false,
  policyVersion: 1
}

export type CohortOverrides = Partial<Policy> & { poNumber?: string; programLabel?: string; salaryDefault?: number }

export function mergePolicy(base: Policy, overrides: Partial<Policy>): Policy {
  return { ...base, ...overrides }
}

/**
 * Soft floor for the REVIEW band = reimbursementMax - reviewBandPaddingCad
 * (e.g. $150 - $10 = $140). This is about "close enough to the cap that Robin
 * should look at it", nothing else.
 *
 * Do NOT use this for shortfall warnings. It used to drive them, which meant a
 * BAM who spent $145 was never reported to Robin even though the ledger flagged
 * the shortfall, because the padding was a leftover from the retired
 * PASS/REVIEW/FAIL model. Use `shortfallWarnBelow()` instead.
 */
export function softFloorFor(policy: Pick<Policy, 'reimbursementMax' | 'reviewBandPaddingCad'>): number {
  return policy.reimbursementMax - policy.reviewBandPaddingCad
}

/**
 * Spend below this triggers a shortfall warning to Robin and the BAM.
 *
 * INTERIM VALUE: $75 (Mirae, 2026-08-07). The final number is not decided yet.
 * The meetings said "warn if they do not spend $150", which would make this equal
 * to reimbursementMax; $140 was never a policy, just the review padding leaking
 * in. Kept as its own named knob so changing it is a one-line edit here.
 *
 * The ledger's own `shortfallFlag` stays at `spent < reimbursementMax` — that is
 * the accounting fact. This threshold only governs when a human gets told.
 */
export const SHORTFALL_WARN_BELOW_CAD = 75

export function shortfallWarnBelow(
  policy: Pick<Policy, 'reimbursementMax'>
): number {
  // Never exceed the cap: a threshold above the max would warn on every BAM.
  return Math.min(SHORTFALL_WARN_BELOW_CAD, policy.reimbursementMax)
}
