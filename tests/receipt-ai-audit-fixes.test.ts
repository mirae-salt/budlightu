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

  // F9 (critic gate 2026-08-07): this used to assert basis 'lines_grossed_up' and
  // $41.98, i.e. $37.15 of Bud Light grossed up by the receipt's BLENDED 13.0%
  // rate. That blend is wrong on a mixed receipt (see the Ontario case below), so
  // the amount is now the conservative PRE-TAX sum and REVIEW is forced.
  // The load-bearing assertion is unchanged and still holds: the stored amount is
  // neither the model's $187 nor the $150 cap.
  it('recompute ignores the model field and derives the pre-tax BL sum, not 187', () => {
    const rc = recomputeBudLightTotal(mixed as any)
    expect(rc.basis).toBe('lines_mixed_pretax')
    expect(rc.mixedPreTax).toBe(true)
    expect(rc.total).toBeCloseTo(37.15, 2)      // 14.99 + 22.16, no blended gross-up
    expect(rc.budLightPreTax).toBeCloseTo(37.15, 2)
    expect(rc.nonBudLightLineCount).toBe(2)
    expect(rc.modelTotal).toBe(187)
    expect(rc.mismatch).toBe(true)
  })

  it('classify forces review and returns the recomputed amount, NOT 187 (and not $150)', () => {
    const out = classifyReceipt({ ocr: mixed as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
    expect(out.status).toBe('review')
    expect(out.reason).toContain('mixed_receipt_pretax')
    // Both figures reach Robin so she can set the true amount with override_total.
    expect(out.reason).toContain('37.15')
    expect(out.reason).toContain('187.00')
    expect(out.budLightTotalInclTax).toBeLessThan(50)
    expect(out.modelReportedTotal).toBe(187)
  })
})

describe('F9: mixed-receipt gross-up (the Ontario worked example)', () => {
  // groceries $50 zero-rated + Bud Light $100 at 13% HST.
  // subtotal 150.00, tax 13.00 -> blended rate 8.67%.
  // Old code: 100 * 1.0867 = $108.67 stored. True tax-inclusive BL: $113.00.
  // Understated by $4.33 per receipt, and the model's correct 113.00 then tripped
  // the >$1 mismatch rule, so it went to review anyway.
  const ontarioMixed = {
    store: 'Metro', date: '2026-09-04',
    lines: [
      { desc: 'GROCERIES', qty: 1, unit: 50.0, total: 50.0, is_bud_light: false, confidence: 0.99 },
      { desc: 'BUD LIGHT 24C', qty: 1, unit: 100.0, total: 100.0, is_bud_light: true, confidence: 0.98 }
    ],
    subtotal: 150.0,
    tax: 13.0,
    grand_total: 163.0,
    bud_light_total_incl_tax: 113.0,
    overall_confidence: 0.97
  }

  it('does NOT apply the blended 8.67% rate, and lands on the true $113.00', () => {
    const rc = recomputeBudLightTotal(ontarioMixed as any)
    // The blend is only a LOWER bound on the beer rate; the upper bound is
    // tax/blSum = 13.00/100 = 13.00%. The reported 113.00 implies exactly 13.00%,
    // which is inside [8.67%, 13.00%] and is Ontario's real rate, so it is
    // corroborated rather than trusted.
    expect(rc.basis).toBe('lines_mixed_rate_validated')
    expect(rc.total).toBe(113)
    expect(rc.total).not.toBeCloseTo(108.67, 2)   // the old, understated figure
    expect(rc.budLightPreTax).toBe(100)
    expect(rc.nonBudLightLineCount).toBe(1)
    expect(rc.budLightLineCount).toBe(1)
  })

  it('a corroborated mixed receipt auto-passes instead of flooding the queue', () => {
    const out = classifyReceipt({
      ocr: ontarioMixed as any, spendableCap: 150, policy: { ...P, firstCohortAllReview: false },
      duplicateHash: false, lowResolutionHeuristic: false
    })
    expect(out.budLightTotalInclTax).toBe(113)
    expect(out.modelReportedTotal).toBe(113)
    // Under $140, so the REVIEW band does not catch it either.
    expect(out.status).toBe('auto_pass')
  })

  it('falls back to the pre-tax sum and REVIEW when the reported figure is not corroborated', () => {
    // Same receipt, but the model returned the grand total (163.00) instead of the
    // Bud Light portion. That implies a 63% rate, far outside [8.67%, 13.00%], so
    // it must not be accepted. This is the original overpayment bug.
    const modelReturnedGrandTotal = { ...ontarioMixed, bud_light_total_incl_tax: 163.0 }
    const rc = recomputeBudLightTotal(modelReturnedGrandTotal as any)
    expect(rc.basis).toBe('lines_mixed_pretax')
    expect(rc.total).toBe(100)

    const out = classifyReceipt({
      ocr: modelReturnedGrandTotal as any, spendableCap: 150, policy: { ...P, firstCohortAllReview: false },
      duplicateHash: false, lowResolutionHeuristic: false
    })
    expect(out.status).toBe('review')
    expect(out.budLightTotalInclTax).toBe(100)
    expect(out.modelReportedTotal).toBe(163)
  })

  it('rejects a reported figure at an implausible rate even inside the bounds', () => {
    // bread $8 and BL $30 both at 13%: bounds are [13.00%, 16.47%]. A reported
    // 34.80 implies 16.00%, which is inside the bounds but is not a Canadian rate.
    const notARealRate = {
      store: 'Loblaws', date: '2026-08-03',
      lines: [
        { desc: 'BUD LIGHT 15C', qty: 1, unit: 30.0, total: 30.0, is_bud_light: true, confidence: 0.98 },
        { desc: 'BREAD', qty: 2, unit: 4.0, total: 8.0, is_bud_light: false, confidence: 0.99 }
      ],
      subtotal: 38.0, tax: 4.94, grand_total: 42.94,
      bud_light_total_incl_tax: 34.8, overall_confidence: 0.97
    }
    const rc = recomputeBudLightTotal(notARealRate as any)
    expect(rc.basis).toBe('lines_mixed_pretax')
    expect(rc.total).toBe(30)
  })

  it('an all-Bud-Light receipt on the same pre-tax basis IS still grossed up', () => {
    const allBl = {
      store: 'The Beer Store', date: '2026-09-04',
      lines: [{ desc: 'BUD LIGHT 24C', qty: 1, unit: 100.0, total: 100.0, is_bud_light: true, confidence: 0.98 }],
      subtotal: 100.0, tax: 13.0, grand_total: 113.0,
      bud_light_total_incl_tax: 113.0, overall_confidence: 0.98
    }
    const rc = recomputeBudLightTotal(allBl as any)
    expect(rc.basis).toBe('lines_grossed_up')
    expect(rc.mixedPreTax).toBe(false)
    expect(rc.total).toBe(113)
    expect(rc.mismatch).toBe(false)
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
  // Review-everything mode is OFF by default (Mirae, 2026-08-10). The whole point
  // of the system is to remove manual checking; 464 receipts a season each needing
  // a click is the problem, not the safeguard. A receipt should reach Robin only
  // when something is genuinely wrong with it.
  it('DEFAULT_POLICY.firstCohortAllReview is false, so a clean receipt auto-passes', () => {
    expect(DEFAULT_POLICY.firstCohortAllReview).toBe(false)
  })

  it('turning it off does NOT disable the real flags: a bad receipt still goes to review', () => {
    const noBudLight = {
      lines: [{ desc: 'MILK', qty: 1, unit: 40, total: 40, is_bud_light: false, confidence: 0.99 }],
      subtotal: 40, tax: 0, grand_total: 40, bud_light_total_incl_tax: 0, overall_confidence: 0.99
    }
    const lowConfidence = {
      lines: [{ desc: 'BUD LIGHT', qty: 1, unit: 40, total: 40, is_bud_light: true, confidence: 0.3 }],
      grand_total: 40, bud_light_total_incl_tax: 40, overall_confidence: 0.3
    }
    const offPolicy = { ...P, firstCohortAllReview: false }

    for (const [label, ocr] of [['no Bud Light lines', noBudLight], ['low confidence', lowConfidence]] as const) {
      const out = classifyReceipt({
        ocr: ocr as never, spendableCap: 150, policy: offPolicy,
        duplicateHash: false, lowResolutionHeuristic: false
      })
      expect(out.status, `${label} must not auto_pass`).not.toBe('auto_pass')
    }

    // And a duplicate is still caught even with review-everything off.
    const dup = classifyReceipt({
      ocr: clean(100) as never, spendableCap: 150, policy: offPolicy,
      duplicateHash: true, lowResolutionHeuristic: false
    })
    expect(dup.status).not.toBe('auto_pass')
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
