import { describe, it, expect } from 'vitest'
import { classifyReceipt, recomputeBudLightTotal } from '../lib/classify-receipt'
import { DEFAULT_POLICY } from '../lib/policy'
import { parseMoney, parseNonNegativeMoney } from '../lib/money'
import { validatePeriod } from '../lib/period'

const P = { ...DEFAULT_POLICY, firstCohortAllReview: false }

describe('P0-F: the audit scenario', () => {
  // $187 receipt, $42 of Bud Light, model returns 187 → used to pay $150
  const mixed = {
    store: 'Real Canadian Superstore',
    date: '2026-08-02',
    lines: [
      { desc: 'BUD LIGHT 6PK', qty: 1, unit: 14.99, total: 14.99, is_bud_light: true, confidence: 0.97 },
      { desc: 'BUD LIGHT LIME 6PK', qty: 1, unit: 22.16, total: 22.16, is_bud_light: true, confidence: 0.96 },
      { desc: 'DIAPERS MEGA', qty: 1, unit: 49.99, total: 49.99, is_bud_light: false, confidence: 0.99 },
      { desc: 'GROCERIES', qty: 1, unit: 78.35, total: 78.35, is_bud_light: false, confidence: 0.99 },
    ],
    subtotal: 165.49,
    tax: 21.51,
    grand_total: 187.0,
    bud_light_total_incl_tax: 187.0,   // <-- the model lying / confused
    overall_confidence: 0.96
  }

  it('recompute ignores the model field and derives $42 -> grossed up ~$47.4', () => {
    const rc = recomputeBudLightTotal(mixed as any)
    expect(rc.basis).toBe('lines_grossed_up')
    expect(rc.total).toBeCloseTo(41.98, 2)
    expect(rc.modelTotal).toBe(187)
    expect(rc.mismatch).toBe(true)
  })

  it('classify forces review and returns the recomputed amount, NOT 187 (and not $150)', () => {
    const out = classifyReceipt({ ocr: mixed as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
    expect(out.status).toBe('review')
    expect(out.reason).toContain('total_mismatch')
    expect(out.budLightTotalInclTax).toBeLessThan(50)
    expect(out.modelReportedTotal).toBe(187)
  })
})

describe('P0-F(b): BL total > grand total', () => {
  it('forces review', () => {
    const ocr = {
      lines: [{ desc: 'BUD LIGHT 24', qty: 1, unit: 200, total: 200, is_bud_light: true, confidence: 0.99 }],
      subtotal: 200, tax: 26, grand_total: 60,
      bud_light_total_incl_tax: 200, overall_confidence: 0.99
    }
    const out = classifyReceipt({ ocr: ocr as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
    expect(out.status).toBe('review')
  })
})

describe('P0-F(c): string / NaN / negative defence', () => {
  it('parseMoney handles "150.00", "$1,150.00", rejects junk', () => {
    expect(parseMoney('150.00')).toBe(150)
    expect(parseMoney('$1,150.00')).toBe(1150)
    expect(parseMoney(' 42.5 ')).toBe(42.5)
    expect(parseMoney('abc')).toBe(null)
    expect(parseMoney(NaN)).toBe(null)
    expect(parseMoney(Infinity)).toBe(null)
    expect(parseMoney(null)).toBe(null)
    expect(parseNonNegativeMoney(-5)).toBe(null)
  })
  it('strips a BOM-prefixed amount rather than silently failing', () => {
    expect(parseMoney('﻿150.00')).toBe(150)
    expect(parseMoney(' 150.00')).toBe(150)
  })
  it('a string model total still yields a numeric stored amount', () => {
    const ocr = {
      lines: [{ desc: 'BUD LIGHT', qty: 1, unit: '80.00', total: '80.00', is_bud_light: true, confidence: 0.99 }],
      grand_total: '80.00',
      bud_light_total_incl_tax: '80.00', overall_confidence: 0.99
    }
    const out = classifyReceipt({ ocr: ocr as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
    expect(typeof out.budLightTotalInclTax).toBe('number')
    expect(out.budLightTotalInclTax).toBe(80)
    expect(out.status).toBe('auto_pass')
  })
  it('an unusable model total forces review, never NaN into the ledger', () => {
    const ocr = {
      lines: [{ desc: 'BUD LIGHT', qty: 1, unit: 80, total: 80, is_bud_light: true, confidence: 0.99 }],
      grand_total: 80, bud_light_total_incl_tax: 'lots', overall_confidence: 0.99
    }
    const out = classifyReceipt({ ocr: ocr as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
    expect(out.status).toBe('review')
    expect(Number.isFinite(out.budLightTotalInclTax)).toBe(true)
    expect(out.budLightTotalInclTax).toBe(80)
  })
  it('model claims money but no BL line -> review, not a payout', () => {
    const ocr = {
      lines: [{ desc: 'MILK', qty: 1, unit: 5, total: 5, is_bud_light: false, confidence: 0.99 }],
      grand_total: 5, bud_light_total_incl_tax: 149, overall_confidence: 0.99
    }
    const out = classifyReceipt({ ocr: ocr as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
    expect(out.status).toBe('review')
    expect(out.budLightTotalInclTax).toBe(0)
  })
})

describe('P0-G: REVIEW band + first-cohort safeguard', () => {
  it('DEFAULT_POLICY.firstCohortAllReview is true (matches DB default + CLAUDE.md)', () => {
    expect(DEFAULT_POLICY.firstCohortAllReview).toBe(true)
  })
  const clean = (total: number) => ({
    lines: [{ desc: 'BUD LIGHT', qty: 1, unit: total, total, is_bud_light: true, confidence: 0.99 }],
    grand_total: total, bud_light_total_incl_tax: total, overall_confidence: 0.99
  })
  it('$140-$149 soft-floor band routes to Robin (was unreachable: isInReviewBand had no callers)', () => {
    for (const t of [140, 145, 149, 149.99]) {
      const out = classifyReceipt({ ocr: clean(t) as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
      expect(out.status, `total ${t}`).toBe('review')
      expect(out.reason).toMatch(/review band/)
    }
  })
  it('$139.99 and below can still auto_pass', () => {
    const out = classifyReceipt({ ocr: clean(139.99) as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
    expect(out.status).toBe('auto_pass')
  })
  it('at/over cap always review, no upper edge', () => {
    for (const t of [150, 165, 1000]) {
      const out = classifyReceipt({ ocr: clean(t) as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
      expect(out.status, `total ${t}`).toBe('review')
    }
  })
  it('unusable spendableCap never auto-passes', () => {
    for (const cap of [NaN, 0, -1, undefined as any]) {
      const out = classifyReceipt({ ocr: clean(50) as any, spendableCap: cap, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
      expect(out.status).toBe('review')
    }
  })
})

describe('P1-24: period validation', () => {
  const now = new Date(Date.UTC(2026, 7, 7)) // 2026-08-07
  const cohort = { start_date: '2026-05-01', end_date: '2027-04-30' }
  it('accepts current and previous month', () => {
    expect(validatePeriod('2026-08', cohort, now)).toEqual({ ok: true, period: '2026-08-01' })
    expect(validatePeriod('2026-07-01', cohort, now)).toEqual({ ok: true, period: '2026-07-01' })
  })
  it('rejects future months', () => {
    expect(validatePeriod('2026-09', cohort, now).ok).toBe(false)
    expect(validatePeriod('2027-01', cohort, now).ok).toBe(false)
  })
  it('rejects months older than the previous one (cap bypass)', () => {
    expect(validatePeriod('2026-06', cohort, now).ok).toBe(false)
    expect(validatePeriod('2026-05', cohort, now).ok).toBe(false)
  })
  it('rejects outside the cohort range', () => {
    const late = { start_date: '2026-09-01', end_date: '2027-04-30' }
    expect(validatePeriod('2026-08', late, now).ok).toBe(false)
  })
  it('rejects garbage and missing cohort dates', () => {
    expect(validatePeriod('not-a-month', cohort, now).ok).toBe(false)
    expect(validatePeriod('2026-13', cohort, now).ok).toBe(false)
    expect(validatePeriod('2026-08', null, now).ok).toBe(false)
    expect(validatePeriod('2026-08-01; drop table receipts', cohort, now).ok).toBe(false)
  })
})
