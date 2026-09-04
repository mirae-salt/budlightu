/**
 * Bottle deposits, and the tax that went missing because of them.
 *
 * Janet, 2026-09-04: "The portal is not including tax amounts from French receipts."
 * The cause was not French. It was the deposit: Quebec receipts print "Dépôt" or
 * "CONSIGNE" as its own line, the deposit is not taxed, and folding it into the taxable
 * Bud Light sum drags the implied rate below the blended lower bound. validateModelRate
 * then rejects the figure and the whole receipt falls back to its PRE-TAX sum. Roman
 * Lombardi lost the entire $12.88 of tax that way.
 *
 * Every fixture below is a real receipt held on 2026-09-04. The two Quebec ones were
 * read off the photographs, not off our own OCR, so the expected totals are what the
 * paper says and not what we already believed.
 */
import { describe, it, expect } from 'vitest'
import { recomputeBudLightTotal, isDepositLine, isDiscountLine } from '../lib/classify-receipt'

const r = (
  store: string,
  subtotal: number,
  tax: number,
  grand_total: number,
  lines: Array<[string, number, boolean]>,
  /** What the model claimed. The mixed-receipt path validates against it, so a fixture
   *  that omits it is not the receipt the server actually saw. */
  bud_light_total_incl_tax = 0
) => ({
  store,
  subtotal,
  tax,
  grand_total,
  bud_light_total_incl_tax,
  overall_confidence: 1,
  lines: lines.map(([desc, total, is_bud_light]) => ({ desc, qty: 1, unit: total, total, is_bud_light, confidence: 1 }))
})

describe('deposits and discounts are recognised', () => {
  it('knows the words Quebec receipts actually print', () => {
    for (const d of ['Dépôt', 'CONSIGNE 2.40$', 'Consigne', 'Deposit (DEP)', 'Container Deposit 36 @ $0.10']) {
      expect(isDepositLine(d)).toBe(true)
    }
    expect(isDepositLine('BUD LIGHT 355ML-24PK')).toBe(false)
  })

  it('treats any negative line as a discount, whatever it is called', () => {
    expect(isDiscountLine('MXM BIERES 2X24PK ET+(', -15.02)).toBe(true)
    expect(isDiscountLine('CARTE-RABAIS 15$ (PROM', 15)).toBe(true)
    expect(isDiscountLine('RABAIS', -10)).toBe(true)
    expect(isDiscountLine('BUD LIGHT', 45.99)).toBe(false)
  })
})

describe('the receipts that were short', () => {
  /*
   * PETRO-CANADA, ST-APOLLINAIRE, read off the photo:
   *   BUD LIGHT 355ML 30   45.99
   *   Dépôt                 3.00
   *   TPS 5.0000 %          2.30      45.99 x 0.05    = 2.2995
   *   TVQ 9.9750 %          4.59      45.99 x 0.09975 = 4.5875
   *   TOTAL CAD            55.88
   * The printed tax is on 45.99 alone, so the deposit is outside the base.
   */
  it('PETRO-CANADA: pays the printed total, not the pre-tax sum', () => {
    const out = recomputeBudLightTotal(r('PETRO-CANADA', 48.99, 6.89, 55.88, [
      ['BUD LIGHT 355ML 30', 45.99, true],
      ['Dépôt', 3.0, false]
    ]))
    expect(out.total).toBe(55.88)
    expect(out.basis).toBe('lines_all_bud_light')
  })

  /*
   * COUCHE-TARD 585, read off the photo. The promo is two lines that net to two cents,
   * so this is still a receipt of nothing but beer:
   *   BUD LIGHT 355ML-24PK  79.98 · CONSIGNE 4.80 · CARTE-RABAIS 15.00 · MXM -15.02
   *   S-Total 84.76 · TPS 4.00 · TVQ 7.98 · Total 96.74
   *   4.00 / 0.05 = 80.00 and 7.98 / 0.09975 = 80.00, against 79.98 - 0.02 of promo.
   */
  it('COUCHE-TARD: a promo pair does not make a beer receipt mixed', () => {
    const out = recomputeBudLightTotal(r('COUCHE-TARD 585', 84.76, 11.98, 96.74, [
      ['BUD LIGHT 355ML-24PK', 79.98, true],
      ['CONSIGNE 2.40$', 4.8, false],
      ['CARTE-RABAIS 15$ (PROM', 15.0, false],
      ['MXM BIERES 2X24PK ET+(', -15.02, false]
    ]))
    expect(out.total).toBe(96.74)
    expect(out.basis).toBe('lines_all_bud_light')
  })

  it('LCBO: a tax-in price still owes the deposit', () => {
    const out = recomputeBudLightTotal(r('LCBO - LESLIEVILLE', 69, 0, 71.4, [
      ['BUD LIGHT 6x473', 69, true],
      ['Deposit (DEP)', 2.4, false]
    ]))
    expect(out.total).toBe(71.4)
  })

  it('Alimentation Brébeuf: the whole tax came back', () => {
    // This is Roman Lombardi's, the worst of them at $12.88 short.
    const out = recomputeBudLightTotal(r('Alimentation Brébeuf', 85.98, 12.88, 104.86, [
      ['BUD LIGHT BIERE', 85.98, true],
      ['+Dépôt bouteille:', 6.0, true]
    ]))
    expect(out.total).toBe(104.86)
  })
})

describe('it must not overpay', () => {
  /*
   * Thomas Levesque's Metro receipt is the one that caught the first version of this
   * fix. Grossing up 79.98 and adding 4.80 of deposit gives 96.76 against a printed
   * total of 85.26, because a RABAIS of -10.00 sits between them: 11.50 more than the
   * student spent. An admin had already corrected this receipt to 85.26 by hand, and
   * the rule now arrives at the same number on its own.
   */
  it('Metro: a discount is not ignored', () => {
    const out = recomputeBudLightTotal(r('Metro Plus Marche Saint-Augustin', 74.78, 10.48, 85.26, [
      ['(2)BUDLIG.BIERE CAN', 79.98, true],
      ['Consigne 2@$2.40', 4.8, true],
      ['RABAIS', -10, false]
    ]))
    expect(out.total).toBe(85.26)
    expect(out.total).toBeLessThanOrEqual(85.26)
  })

  it('never exceeds the receipt total on a mixed receipt either', () => {
    const out = recomputeBudLightTotal(r('MAXI MONT-TREMBLANT', 36.59, 5.27, 41.86, [
      ['BUD D LIME 12PK', 25.69, true],
      ['CONSIGNE', 1.2, true],
      ['SLL LVNT BIERE', 4.5, false],
      ['CONSIGNE', 0.1, false],
      ['SHAW BIER ST SAU', 5.0, false],
      ['CONSIGNE', 0.1, false]
    ]))
    expect(out.total).toBeLessThanOrEqual(41.86)
    // 25.69 x 1.14975 = 29.54, plus 1.20 of deposit at face value.
    expect(out.total).toBeCloseTo(30.74, 2)
    expect(out.basis).toBe('lines_deposit_aware')
  })
})

describe('receipts that were already right stay right', () => {
  it('a grocery shop with beer in it is unchanged', () => {
    // Groceries are zero-rated, so all of the tax is the beer's. This was already
    // correct through the mixed-rate path and must not move.
    const out = recomputeBudLightTotal(r('Metro #4521', 77.6, 11.62, 89.22, [
      ['LAIT 2% 2L', 4.99, false],
      ['PAIN BLANC', 3.49, false],
      ['FROMAGE CHEDDAR 400g', 7.99, false],
      ['BUDLIG.BIERE CAN 12X355', 22.95, true],
      ['CHIPS LAYS SEL', 4.99, false],
      ['BUDLIG.LIME 6X355', 14.95, true],
      ['JUS ORANGE 1.89L', 5.29, false],
      ['BUDLISELT.EAU P. 6X355', 12.95, true]
    ], 58.45))
    expect(out.total).toBeCloseTo(58.45, 2)
    expect(out.basis).toBe('lines_mixed_rate_validated')
  })

  it('a receipt with no deposit at all is unaffected', () => {
    const out = recomputeBudLightTotal(r('BEER STORE', 36.96, 4.81, 41.77, [
      ['BL STRAWBERRY LEMON', 8.97, true],
      ['BUD LIGHT 473ML 12TC', 27.99, true]
    ]))
    expect(out.total).toBe(41.77)
  })

  it('a mixed receipt with an unmarked deposit stays conservative', () => {
    // Samantha Graham's NSLC receipt: an Arizona Hard makes it genuinely mixed, and the
    // model did not mark which deposits belong to the beer. Leaving them out pays a
    // little less rather than guessing, and the receipt goes to a human anyway.
    const out = recomputeBudLightTotal(r('NSLC', 112.92, 15.05, 127.97, [
      ['BUD LIGHT LAGER', 28.32, true],
      ['Bottle Deposit 12 @ $0.10', 1.2, false],
      ['BUD LIGHT LAGER', 61.31, true],
      ['Container Deposit 36 @ $0.10', 3.6, false],
      ['ARIZONA HARD 2G SUGAR', 17.89, false],
      ['Container Deposit 6 @ $0.10', 0.6, false]
    ]))
    expect(out.total).toBeLessThanOrEqual(127.97)
    expect(out.total).toBeCloseTo(102.18, 2)
  })
})
