/**
 * Policy shape + defaults. Materialized values live in the `policy` table
 * (see supabase/migrations/0006_seed_policy.sql) and can be overridden
 * per-cohort in the `cohorts` table.
 */

import type { Policy } from './reimbursement'

export const DEFAULT_POLICY: Policy = {
  reimbursementMax: 150,
  rolloverMode: 'accumulate',
  capMultiplier: 1,
  reviewBandPaddingUsd: 10,
  firstCohortAllReview: true,
  policyVersion: 1
}

export type CohortOverrides = Partial<Policy> & { poNumber?: string; programLabel?: string; salaryDefault?: number }

export function mergePolicy(base: Policy, overrides: Partial<Policy>): Policy {
  return { ...base, ...overrides }
}
