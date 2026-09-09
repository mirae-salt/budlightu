import { describe, it, expect } from 'vitest'
import { classifyReceipt } from '../lib/classify-receipt'
import { DEFAULT_POLICY } from '../lib/policy'

const basePolicy = { ...DEFAULT_POLICY, firstCohortAllReview: false }

function mkOcr(overrides: Partial<{
  total: number, confidence: number, lines: any[], ambiguous: boolean
}> = {}) {
  const total = overrides.total ?? 165
  const lines = overrides.lines ?? [{
    desc: 'BUD LIGHT 24-PACK', qty: 1, unit: total, total,
    is_bud_light: true, confidence: 0.95
  }]
  if (overrides.ambiguous) lines[0].ambiguous = true
  return {
    lines,
    bud_light_total_incl_tax: total,
    overall_confidence: overrides.confidence ?? 0.95
  }
}

describe('classifyReceipt', () => {
  it('clean receipt with total >= cap ($165 with $150 cap) → always review, never auto_pass', () => {
    const out = classifyReceipt({
      ocr: mkOcr(), // total defaults to 165
      spendableCap: 150,
      policy: basePolicy,
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('review')
    // mkOcr reports no grand_total, so nothing corroborates the $165 and it still needs
    // a person. A receipt whose printed total says $165 clears; see overspend-cap.test.ts.
    expect(out.reason).toMatch(/^overspend: spent \$165\.00/)
    expect(out.reason).toMatch(/does not confirm that figure/)
    expect(out.reason).not.toMatch(/spendable_cap/)
  })

  it('clean receipt genuinely below the review band → auto_pass', () => {
    const out = classifyReceipt({
      ocr: mkOcr({ total: 80 }),
      spendableCap: 150,
      policy: basePolicy,
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('auto_pass')
  })

  it('first_cohort_all_review overrides everything → review', () => {
    const out = classifyReceipt({
      ocr: mkOcr(),
      spendableCap: 150,
      policy: { ...basePolicy, firstCohortAllReview: true },
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('review')
    expect(out.reason).toContain('first_cohort_all_review')
  })

  it('boundary at fresh max ($148) → review', () => {
    const out = classifyReceipt({
      ocr: mkOcr({ total: 148 }),
      spendableCap: 150,
      policy: basePolicy,
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('review')
    expect(out.reason).toMatch(/^review_band: /)
  })

  it('boundary at ROLLING cap ($195 with spendableCap=200) → review (P0-2 verified)', () => {
    const out = classifyReceipt({
      ocr: mkOcr({ total: 195 }),
      spendableCap: 200,
      policy: basePolicy,
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('review')
  })

  it('low confidence → review', () => {
    const out = classifyReceipt({
      ocr: mkOcr({ confidence: 0.7 }),
      spendableCap: 150,
      policy: basePolicy,
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('review')
  })

  it('ambiguous line → review', () => {
    const out = classifyReceipt({
      ocr: mkOcr({ ambiguous: true }),
      spendableCap: 150,
      policy: basePolicy,
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('review')
  })

  it('duplicate hash → review', () => {
    const out = classifyReceipt({
      ocr: mkOcr(),
      spendableCap: 150,
      policy: basePolicy,
      duplicateHash: true,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('review')
    expect(out.reason).toMatch(/duplicate/)
  })

  it('no Bud Light detected → rejected', () => {
    const out = classifyReceipt({
      ocr: {
        lines: [{ desc: 'MILK 2%', qty: 1, unit: 5, total: 5, is_bud_light: false, confidence: 0.99 }],
        bud_light_total_incl_tax: 0,
        overall_confidence: 0.99
      },
      spendableCap: 150,
      policy: basePolicy,
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('rejected')
  })
})
