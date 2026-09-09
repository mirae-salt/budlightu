/**
 * Being over the monthly cap does not by itself need a person.
 *
 * Mirae, 2026-09-09: the ledger already pays min(spent, cap), so a $203 receipt reimburses
 * the cap whether or not anybody clicks approve. What the review was still buying was a
 * guard against the other reason a figure lands over the cap, which is the model reading
 * it too high. Past the cap every wrong-high number pays the same amount.
 *
 * Every case below is a real September receipt.
 */
import { describe, it, expect } from 'vitest'
import { classifyReceipt, recomputeBudLightTotal, OVERSPEND_OUTLIER_MULTIPLE } from '../lib/classify-receipt'
import { DEFAULT_POLICY } from '../lib/policy'

const policy = { ...DEFAULT_POLICY, firstCohortAllReview: false }

/** A receipt of nothing but Bud Light, so the amount is the printed total. */
function beerOnly(printedTotal: number, subtotal: number, tax: number) {
  return {
    store: 'LIQUOR STORE',
    subtotal,
    tax,
    grand_total: printedTotal,
    // The model reports the tax-inclusive figure, which on an all-beer receipt with no
    // deposit is the printed total. Setting it to the pre-tax subtotal here made every
    // fixture trip the model-vs-recompute mismatch before it ever reached the band.
    bud_light_total_incl_tax: printedTotal,
    overall_confidence: 1,
    lines: [
      { desc: 'BUD LIGHT 24PK', qty: 1, unit: subtotal, total: subtotal, is_bud_light: true, confidence: 1 }
    ]
  }
}

const decide = (ocr: unknown) => classifyReceipt({
  ocr: ocr as never, spendableCap: 150, policy, duplicateHash: false, lowResolutionHeuristic: false
})

describe('over the cap, and the printed total says so', () => {
  it.each([
    ['Mackenzie Tomm', 150.62],
    ['Lucas Van Dam', 157.77],
    ['Jocelyn Gallo', 159.51],
    ['Kennedy Cober', 162.46]
  ])('%s at $%d clears without a person', (_who, printed) => {
    const out = decide(beerOnly(printed, printed - 6, 6))
    expect(out.status).toBe('auto_pass')
    expect(out.budLightTotalInclTax).toBe(printed)
  })

  it('records the overspend in the reason rather than hiding it', () => {
    const out = decide(beerOnly(157.77, 151.77, 6))
    expect(out.reason).toMatch(/^overspend:/)
    expect(out.reason).toMatch(/over the \$150\.00 monthly cap/)
    expect(out.reason).toMatch(/the cap is what is reimbursed/i)
  })
})

describe('over the cap with nothing corroborating the figure', () => {
  it("Thomas Ambrosio's Costco run still goes to a person", () => {
    // $65 membership renewal on the same receipt, so the model had to choose which lines
    // were beer, and the printed total ($288.83) does not confirm our $203.38.
    const costco = {
      store: 'COSTCO WHOLESALE',
      subtotal: 256.98,
      tax: 31.85,
      grand_total: 288.83,
      bud_light_total_incl_tax: 203.38,
      overall_confidence: 1,
      lines: [
        { desc: '1012471 BUD LIGHT', qty: 1, unit: 89.99, total: 89.99, is_bud_light: true, confidence: 1 },
        { desc: 'DEPOSIT VL', qty: 1, unit: 6, total: 6, is_bud_light: false, confidence: 1 },
        { desc: 'GLDSTRRNWL', qty: 1, unit: 65, total: 65, is_bud_light: false, confidence: 1 },
        { desc: '1012471 BUD LIGHT', qty: 1, unit: 89.99, total: 89.99, is_bud_light: true, confidence: 1 },
        { desc: 'DEPOSIT VL', qty: 1, unit: 6, total: 6, is_bud_light: false, confidence: 1 }
      ]
    }
    expect(recomputeBudLightTotal(costco).matchesPrintedTotal).toBe(false)
    const out = decide(costco)
    expect(out.status).toBe('review')
    expect(out.reason).toMatch(/does not confirm that figure/)
  })
})

describe('a figure several times the cap is checked whatever confirms it', () => {
  it(`refuses to auto-pass at more than ${OVERSPEND_OUTLIER_MULTIPLE}x, even on a beer-only receipt`, () => {
    // The corroboration argument stops working here: a decimal misread that corrupts the
    // lines and the printed total together would look exactly like this.
    const out = decide(beerOnly(520, 500, 20))
    expect(out.status).toBe('review')
    expect(out.reason).toMatch(/more than 2 times/)
  })

  it('the boundary itself still clears', () => {
    const out = decide(beerOnly(300, 288, 12))
    expect(out.status).toBe('auto_pass')
  })
})

describe('nothing else about the band changed', () => {
  it('just under the cap is still a program manager decision', () => {
    // The soft-floor band, $140 to $150, is untouched by this.
    const out = decide(beerOnly(145, 139, 6))
    expect(out.status).toBe('review')
    expect(out.reason).toMatch(/^review_band:/)
  })

  it('an ordinary receipt well under the cap still clears', () => {
    expect(decide(beerOnly(80, 75, 5)).status).toBe('auto_pass')
  })

  it('an over-cap receipt whose lines contradict it is still refused', () => {
    // exceedsGrandTotal and the mismatch checks run before the band and are unchanged.
    const contradictory = { ...beerOnly(160, 154, 6), bud_light_total_incl_tax: 20 }
    expect(decide(contradictory).status).toBe('review')
  })
})
