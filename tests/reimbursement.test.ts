import { describe, it, expect } from 'vitest'
import { computeMonthlyReimbursement, isInReviewBand } from '../lib/reimbursement'
import { DEFAULT_POLICY } from '../lib/policy'

const policy = { ...DEFAULT_POLICY, firstCohortAllReview: false } // testing computation logic; classifier gate tested separately

describe('computeMonthlyReimbursement — happy path', () => {
  it('spent >= entitlement, no carryover → paid = entitlement (150), no carry out', () => {
    const out = computeMonthlyReimbursement({
      period: '2026-09-01',
      monthsActiveThroughPeriod: 1,
      receiptsTotalInclHst: 162,
      priorLedger: [],
      policy
    })
    expect(out.entitlement).toBe(150)
    expect(out.paidThisMonth).toBe(150)
    expect(out.carryoverOut).toBe(0)
    expect(out.shortfallFlag).toBe(false)
  })

  it('spent < entitlement → paid = spent, shortfall flagged, unspent forfeited (no rollover)', () => {
    const out = computeMonthlyReimbursement({
      period: '2026-09-01',
      monthsActiveThroughPeriod: 1,
      receiptsTotalInclHst: 120,
      priorLedger: [],
      policy
    })
    expect(out.paidThisMonth).toBe(120)
    expect(out.carryoverOut).toBe(0)
    expect(out.shortfallFlag).toBe(true)
  })

  it('spent = 0 → paid = 0, full entitlement forfeited (no rollover)', () => {
    const out = computeMonthlyReimbursement({
      period: '2026-09-01',
      monthsActiveThroughPeriod: 1,
      receiptsTotalInclHst: 0,
      priorLedger: [],
      policy
    })
    expect(out.paidThisMonth).toBe(0)
    expect(out.carryoverOut).toBe(0)
    expect(out.shortfallFlag).toBe(true)
  })
})

describe('computeMonthlyReimbursement — no rollover (forfeit, default policy)', () => {
  it('unspent from a prior month never carries in — spendable cap stays at flat entitlement', () => {
    // Even if a prior ledger row somehow recorded a carryover_out (e.g. legacy data or
    // a cohort override was toggled off), the default forfeit policy computes carryoverIn
    // from the prior row's carryoverOutCad, which forfeit mode always writes as 0 going
    // forward — so from this point on, nothing accumulates.
    const priorLedger = [{
      period: '2026-09-01',
      entitlementCad: 150, spentCad: 120,
      carryoverInCad: 0, carryoverOutCad: 0,
      paidCad: 120, spendableCapCad: 150, capSnapshotCad: 150,
      shortfallFlag: true, policyVersion: 1
    }]
    const out = computeMonthlyReimbursement({
      period: '2026-10-01',
      monthsActiveThroughPeriod: 2,
      receiptsTotalInclHst: 170,
      priorLedger,
      policy
    })
    expect(out.carryoverIn).toBe(0)
    expect(out.spendableCap).toBe(150)
    expect(out.paidThisMonth).toBe(150)
    expect(out.carryoverOut).toBe(0)
    expect(out.shortfallFlag).toBe(false) // spent 170 >= entitlement 150
  })

  it('spend exceeds flat cap → paid capped at $150, no negative carry, no carry out', () => {
    const priorLedger = [{
      period: '2026-09-01',
      entitlementCad: 150, spentCad: 100,
      carryoverInCad: 0, carryoverOutCad: 0,
      paidCad: 100, spendableCapCad: 150, capSnapshotCad: 150,
      shortfallFlag: true, policyVersion: 1
    }]
    const out = computeMonthlyReimbursement({
      period: '2026-10-01',
      monthsActiveThroughPeriod: 2,
      receiptsTotalInclHst: 500,
      priorLedger,
      policy
    })
    expect(out.spendableCap).toBe(150)
    expect(out.paidThisMonth).toBe(150)
    expect(out.carryoverOut).toBe(0)
  })
})

describe('computeMonthlyReimbursement — forfeit mode (explicit)', () => {
  it('unspent → paid = spent, carryover out = 0 (never rolls forward)', () => {
    const forfeit = { ...policy, rolloverMode: 'forfeit' as const }
    const out = computeMonthlyReimbursement({
      period: '2026-09-01',
      monthsActiveThroughPeriod: 1,
      receiptsTotalInclHst: 100,
      priorLedger: [],
      policy: forfeit
    })
    expect(out.paidThisMonth).toBe(100)
    expect(out.carryoverOut).toBe(0)
  })
})

describe('computeMonthlyReimbursement — cumulative cap safety net', () => {
  it('never pays beyond monthsActive × max, and forfeit means no carryover ever accrues', () => {
    const priorLedger = [{
      period: '2026-09-01',
      entitlementCad: 150, spentCad: 0,
      carryoverInCad: 0, carryoverOutCad: 0,
      paidCad: 0, spendableCapCad: 150, capSnapshotCad: 150,
      shortfallFlag: true, policyVersion: 1
    }]
    const out = computeMonthlyReimbursement({
      period: '2026-10-01',
      monthsActiveThroughPeriod: 2, // program cap = 2 * 150 = 300
      receiptsTotalInclHst: 400,
      priorLedger,
      policy
    })
    expect(out.spendableCap).toBe(150)  // no carryover under forfeit
    expect(out.capSnapshot).toBe(300)   // 2 * 150 (cumulative program-wide cap, unaffected)
    expect(out.paidThisMonth).toBe(150) // min(400, 150, 300)
    expect(out.carryoverOut).toBe(0)
  })
})

describe('isInReviewBand — HIGH fix: $150+ always flagged', () => {
  it('receipt near rolling cap boundary (below cap) → REVIEW', () => {
    // spendableCap = 200 (150 + 50 carry), receipt = 195 → within [190, 200)
    expect(isInReviewBand(195, 200, 150, 10)).toBe(true)
  })

  it('receipt at or over rolling cap → REVIEW, with NO upper edge (unlike old ±padding band)', () => {
    expect(isInReviewBand(200, 200, 150, 10)).toBe(true)
    expect(isInReviewBand(210, 200, 150, 10)).toBe(true)
    expect(isInReviewBand(500, 200, 150, 10)).toBe(true) // far over cap — still REVIEW, never auto_pass
  })

  it('receipt at fresh max boundary → REVIEW (even without carryover)', () => {
    expect(isInReviewBand(148, 150, 150, 10)).toBe(true)
  })

  it('receipt at or over fresh max ($150+) → REVIEW even with no carryover, no matter how high', () => {
    expect(isInReviewBand(150, 150, 150, 10)).toBe(true)
    expect(isInReviewBand(165, 150, 150, 10)).toBe(true)
    expect(isInReviewBand(1000, 150, 150, 10)).toBe(true)
  })

  it('receipt far from all boundaries → NOT review', () => {
    expect(isInReviewBand(80, 200, 150, 10)).toBe(false)
  })

  it('just below the near-cap padding window (and below fresh max) → NOT review', () => {
    expect(isInReviewBand(100, 200, 150, 10)).toBe(false)
  })
})
