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
  // P0-G (audit 2026-08-07): default TRUE, matching the DB column default
  // (cohorts.first_cohort_all_review) and CLAUDE.md. Fail-closed: if a cohort
  // row cannot be read, every receipt goes to Robin instead of auto-passing.
  firstCohortAllReview: true,
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
