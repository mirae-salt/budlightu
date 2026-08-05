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
  firstCohortAllReview: true,
  policyVersion: 1
}

export type CohortOverrides = Partial<Policy> & { poNumber?: string; programLabel?: string; salaryDefault?: number }

export function mergePolicy(base: Policy, overrides: Partial<Policy>): Policy {
  return { ...base, ...overrides }
}

/**
 * Soft floor for shortfall warnings = reimbursementMax - reviewBandPaddingCad
 * (e.g. $150 - $10 = $140). Derived from policy instead of hardcoded so a
 * cohort override to reimbursementMax or reviewBandPaddingCad propagates
 * automatically.
 */
export function softFloorFor(policy: Pick<Policy, 'reimbursementMax' | 'reviewBandPaddingCad'>): number {
  return policy.reimbursementMax - policy.reviewBandPaddingCad
}
