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

  it('spent < entitlement → paid = spent, shortfall flagged, unspent rolls out (accumulate)', () => {
    const out = computeMonthlyReimbursement({
      period: '2026-09-01',
      monthsActiveThroughPeriod: 1,
      receiptsTotalInclHst: 120,
      priorLedger: [],
      policy
    })
    expect(out.paidThisMonth).toBe(120)
    expect(out.carryoverOut).toBe(30)
    expect(out.shortfallFlag).toBe(true)
  })

  it('spent = 0 → paid = 0, full entitlement rolls out (accumulate)', () => {
    const out = computeMonthlyReimbursement({
      period: '2026-09-01',
      monthsActiveThroughPeriod: 1,
      receiptsTotalInclHst: 0,
      priorLedger: [],
      policy
    })
    expect(out.paidThisMonth).toBe(0)
    expect(out.carryoverOut).toBe(150)
    expect(out.shortfallFlag).toBe(true)
  })
})

describe('computeMonthlyReimbursement — rollover (accumulate)', () => {
  it('carries in unspent from prior month, allows spend up to combined cap', () => {
    const priorLedger = [{
      period: '2026-09-01',
      entitlementUsd: 150, spentUsd: 120,
      carryoverInUsd: 0, carryoverOutUsd: 30,
      paidUsd: 120, spendableCapUsd: 150, capSnapshotUsd: 150,
      shortfallFlag: true, policyVersion: 1
    }]
    const out = computeMonthlyReimbursement({
      period: '2026-10-01',
      monthsActiveThroughPeriod: 2,
      receiptsTotalInclHst: 170,
      priorLedger,
      policy
    })
    expect(out.carryoverIn).toBe(30)
    expect(out.spendableCap).toBe(180)
    expect(out.paidThisMonth).toBe(170)
    expect(out.carryoverOut).toBe(10)
    expect(out.shortfallFlag).toBe(false) // spent 170 >= entitlement 150
  })

  it('spend exceeds spendable cap → paid capped at spendableCap, no negative carry', () => {
    const priorLedger = [{
      period: '2026-09-01',
      entitlementUsd: 150, spentUsd: 100,
      carryoverInUsd: 0, carryoverOutUsd: 50,
      paidUsd: 100, spendableCapUsd: 150, capSnapshotUsd: 150,
      shortfallFlag: true, policyVersion: 1
    }]
    const out = computeMonthlyReimbursement({
      period: '2026-10-01',
      monthsActiveThroughPeriod: 2,
      receiptsTotalInclHst: 500,
      priorLedger,
      policy
    })
    expect(out.spendableCap).toBe(200)
    expect(out.paidThisMonth).toBe(200)
    expect(out.carryoverOut).toBe(0)
  })
})

describe('computeMonthlyReimbursement — forfeit mode', () => {
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
  it('never pays beyond monthsActive × max even if carryover somehow exceeds', () => {
    const priorLedger = [{
      period: '2026-09-01',
      entitlementUsd: 150, spentUsd: 0,
      carryoverInUsd: 0, carryoverOutUsd: 150,
      paidUsd: 0, spendableCapUsd: 150, capSnapshotUsd: 150,
      shortfallFlag: true, policyVersion: 1
    }]
    const out = computeMonthlyReimbursement({
      period: '2026-10-01',
      monthsActiveThroughPeriod: 2, // program cap = 2 * 150 = 300
      receiptsTotalInclHst: 400,
      priorLedger,
      policy
    })
    expect(out.spendableCap).toBe(300)  // 150 + 150 carryover
    expect(out.capSnapshot).toBe(300)   // 2 * 150
    expect(out.paidThisMonth).toBe(300) // min(400, 300, 300)
  })
})

describe('isInReviewBand — P0-2 fix', () => {
  it('receipt at rolling cap boundary → REVIEW', () => {
    // spendableCap = 200 (150 + 50 carry), receipt = 195 → falls in [190, 210]
    expect(isInReviewBand(195, 200, 150, 10)).toBe(true)
  })

  it('receipt at fresh max boundary → REVIEW (even without carryover)', () => {
    expect(isInReviewBand(148, 150, 150, 10)).toBe(true)
  })

  it('receipt far from all boundaries → NOT review', () => {
    expect(isInReviewBand(80, 200, 150, 10)).toBe(false)
  })

  it('boundary edge inclusive at spendableCap + padding', () => {
    expect(isInReviewBand(210, 200, 150, 10)).toBe(true)
    expect(isInReviewBand(211, 200, 150, 10)).toBe(false)
  })
})
