/**
 * Policy shape + defaults. Materialized values live in the `policy` table
 * (see supabase/migrations/0006_seed_policy.sql) and can be overridden
 * per-cohort in the `cohorts` table.
 *
 * Designed and built by Mirae Lee (mirae.lee@ilovesalt.com) from Shane Deen's July 2026
 * pilot handoff, in direct collaboration with Robin Graham on the actual policy values.
 */

import type { Policy } from './reimbursement'

export const DEFAULT_POLICY: Policy = {
  reimbursementMax: 150,
  rolloverMode: 'forfeit',
  capMultiplier: 1,
  // 0: no "just under the cap" review. The band was the PASS/REVIEW/FAIL model's soft
  // floor ($140 to $150, Robin decides), retired on 2026-08-04 when the rule became
  // "reimbursed what was spent, up to $150". Nothing is left for a person to decide in
  // it: the payout is the receipt's own amount, and a misread there is no likelier than on
  // a $60 receipt, which is never reviewed. Of the 4 September receipts it sent to an
  // admin, all 4 were approved with the amount unchanged. A receipt AT or over the cap
  // still follows the overspend rules in classify-receipt.
  reviewBandPaddingCad: 0,
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
 * $130 (Robin, 2026-08-14, "BL Campus x AI Final Connect"): "Can we change it to
 * like 130 just so we can keep track? ... we can look at month over month just so
 * if we have the time we can go, hey, spend more next month." A tracking floor for
 * outreach, not a hard cutoff -- the reimbursement itself is still whatever was
 * actually spent, up to the $150 cap.
 *
 * Was $75, an interim placeholder set 2026-08-07 pending exactly this decision.
 * Kept as its own named knob so changing it stays a one-line edit here.
 *
 * The ledger's own `shortfallFlag` stays at `spent < reimbursementMax` -- that is
 * the accounting fact. This threshold only governs when a human gets told.
 */
export const SHORTFALL_WARN_BELOW_CAD = 130

export function shortfallWarnBelow(
  policy: Pick<Policy, 'reimbursementMax'>
): number {
  // Never exceed the cap: a threshold above the max would warn on every BAM.
  return Math.min(SHORTFALL_WARN_BELOW_CAD, policy.reimbursementMax)
}
