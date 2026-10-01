/**
 * Flags that sent a receipt to a person and changed nothing.
 *
 * Of the 40 receipts an admin decided by 2026-09-29, 23 were approved without touching
 * the amount or a single line. Seven of those were a check firing on arithmetic that was
 * fine, and three lines the model read as products were really a fee, a tax or a
 * deposit. Every fixture below is one of those receipts, with the store as printed.
 */
import { describe, it, expect } from 'vitest'
import {
  isDepositLine,
  isTaxLine,
  taxIncludedInLines,
  recomputeBudLightTotal,
  classifyReceipt
} from '../lib/classify-receipt'
import { DEFAULT_POLICY } from '../lib/policy'

const policy = { ...DEFAULT_POLICY, firstCohortAllReview: false }
const classify = (ocr: unknown) =>
  classifyReceipt({ ocr: ocr as never, spendableCap: 150, policy, duplicateHash: false, lowResolutionHeuristic: false })

const bl = (desc: string, total: number, confidence = 1) => ({ desc, qty: 1, unit: total, total, is_bud_light: true, confidence })
const other = (desc: string, total: number, confidence = 1) => ({ desc, qty: 1, unit: total, total, is_bud_light: false, confidence })
const included = (ocr: unknown) => taxIncludedInLines(ocr as never)

describe('taxIncludedInLines: prices that already carry the tax', () => {
  it('LCBO: two $17.25 packs and a $34.50 total, though subtotal + tax says $37.27', () => {
    const lcbo = {
      store: 'LCBO', subtotal: 33.3, tax: 3.97, grand_total: 34.5, bud_light_total_incl_tax: 34.5,
      overall_confidence: 0.95, lines: [bl('BUD LIGHT 6X473', 17.25), bl('BUD LIGHT 6X473', 17.25)]
    }
    expect(included(lcbo)).toBe(true)
    const out = classify(lcbo)
    expect(out.status).toBe('auto_pass')
    expect(out.budLightTotalInclTax).toBe(34.5)
  })

  it('LCBO again, $77.20 across two lines', () => {
    expect(included({
      subtotal: 77.2, tax: 8.88, grand_total: 77.2,
      lines: [bl('BUD LIGHT 6X473', 17.25), bl('BUD LIGHT 30X355', 59.95)]
    })).toBe(true)
  })

  it('is false on an Uber Eats order, where the lines stop at the subtotal and a fee follows', () => {
    expect(included({
      subtotal: 62.78, tax: 12.2, grand_total: 95.53,
      lines: [bl('Bud Light Double Lime 6 Can', 22.59), bl('Bud Light Light Lager Beer (12 x 341 ml)', 40.19)]
    })).toBe(false)
  })

  it('is false when a line cannot be read, so a guess never qualifies', () => {
    expect(included({
      grand_total: 34.5, lines: [bl('BUD LIGHT', 17.25), { desc: 'BUD LIGHT', is_bud_light: true, total: 'n/a' }]
    })).toBe(false)
  })

  it('is false with no printed total or no lines', () => {
    expect(included({ lines: [bl('BUD LIGHT', 10)] })).toBe(false)
    expect(included({ grand_total: 10, lines: [] })).toBe(false)
    expect(included(null)).toBe(false)
  })
})

describe('the model rounds the tax rate', () => {
  const maxi = {
    store: 'MAXI STE-FOY QUATRE-BOURGEOIS (#7222)', subtotal: 147.56, tax: 20.66, grand_total: 168.22,
    bud_light_total_incl_tax: 157.27, overall_confidence: 1,
    lines: [bl('(2)06206756797 BUD LIGHT BIERE FPQ', 137.96), other('CONSIGNE 1', 9.6)]
  }

  it('Maxi: 137.96 x 1.14 is 157.27, the receipt charged 14.975%, and our figure is the printed total', () => {
    const rc = recomputeBudLightTotal(maxi as never)
    expect(rc.total).toBe(168.22)
    expect(rc.matchesPrintedTotal).toBe(true)
    expect(rc.mismatch).toBe(false)
  })

  it('still flags a model figure that is a real product away', () => {
    // A $12.99 item ticked as Bud Light would leave the model about $15 short of us.
    const out = recomputeBudLightTotal({ ...maxi, bud_light_total_incl_tax: 143 } as never)
    expect(out.mismatch).toBe(true)
  })

  it('keeps the flat $1 tolerance on a small receipt', () => {
    const small = { subtotal: 10, tax: 1.3, grand_total: 11.3, bud_light_total_incl_tax: 9.9, lines: [bl('BUD LIGHT', 10)] }
    expect(recomputeBudLightTotal(small as never).mismatch).toBe(true)
  })
})

describe('isDepositLine: Quebec environmental fee and the bare BOUT', () => {
  it.each([
    "Frais l'environnement",   // Roi d'la biere
    'Frais l’environnement',   // curly apostrophe
    "Frais d'environnement",
    "Frais de l'environnement",
    'BOUT'                      // Green's Superette
  ])('reads "%s" as a deposit', d => expect(isDepositLine(d)).toBe(true))

  it.each([
    'BOUTEILLE EAU 500ML',      // a product
    'ABOUT',
    'BOUT DE FILET',
    'Environnement'             // no fee word
  ])('does not read "%s" as a deposit', d => expect(isDepositLine(d)).toBe(false))

  const roi = {
    store: "Roi d'la bière", subtotal: 156.35, tax: 21.89, grand_total: 178.24, bud_light_total_incl_tax: 163.85,
    overall_confidence: 0.95,
    lines: [
      bl('12/CAN BL D LIGHT LIME', 23.99, 0.95), other("Frais l'environnement", 0.48, 0.9), other('Dépôt de bouteille', 1.2, 0.9),
      bl('2x30/CAN BUD LIGHT', 79.89, 0.95), other("Frais l'environnement", 1.2, 0.9), other('Dépôt de bouteille', 6, 0.9),
      bl('30/CAN BL D. LIGHT', 39.99, 0.95), other("Frais l'environnement", 0.6, 0.9), other('Dépôt de bouteille', 3, 0.9)
    ]
  }

  it("Roi d'la biere clears: the model's figure is 1.07% short, from a rounded Quebec rate", () => {
    const out = classify(roi)
    expect(out.budLightTotalInclTax).toBe(178.24)
    expect(out.status).toBe('auto_pass')
  })

  it("but a second brand of beer on the same receipt still goes to a person", () => {
    // A $12 six-pack the model did not count as Bud Light: 6.7% of the total.
    const out = classify({ ...roi, bud_light_total_incl_tax: 163.85 - 12 })
    expect(out.status).toBe('review')
    expect(out.reason).toMatch(/^total_mismatch/)
  })

  it("Roi d'la biere: the recompute lands on the printed $178.24", () => {
    const rc = recomputeBudLightTotal({
      store: "Roi d'la bière", subtotal: 156.35, tax: 21.89, grand_total: 178.24, bud_light_total_incl_tax: 163.85,
      lines: [
        bl('12/CAN BL D LIGHT LIME', 23.99, 0.95), other("Frais l'environnement", 0.48, 0.9), other('Dépôt de bouteille', 1.2, 0.9),
        bl('2x30/CAN BUD LIGHT', 79.89, 0.95), other("Frais l'environnement", 1.2, 0.9), other('Dépôt de bouteille', 6, 0.9),
        bl('30/CAN BL D. LIGHT', 39.99, 0.95), other("Frais l'environnement", 0.6, 0.9), other('Dépôt de bouteille', 3, 0.9)
      ]
    } as never)
    expect(rc.total).toBe(178.24)
  })
})

describe('isTaxLine: the receipt\'s own tax listed as an item', () => {
  it.each(['HST', 'GST', 'TPS', 'TVQ', 'Tax', 'HST 13%', 'TPS 5.000%', 'HST (13%)'])(
    'reads "%s" as tax', d => expect(isTaxLine(d)).toBe(true))

  it.each(['HST HONEY 500G', 'TAXI ALE', 'BUD LIGHT', 'TAX FREE SODA', ''])(
    'does not read "%s" as tax', d => expect(isTaxLine(d)).toBe(false))

  it('Beer Store: an HST line no longer makes a beer-only receipt mixed, and the amount is $54.37', () => {
    const beerStore = {
      store: 'BEER STORE', subtotal: 45.99, tax: 5.98, grand_total: 54.37, bud_light_total_incl_tax: 51.97,
      overall_confidence: 0.95,
      lines: [bl('BUD LIGHT 355ML 24UC CA', 45.99), other('DEPOSIT', 2.4, 0.95), other('HST', 5.98, 0.95)]
    }
    const out = classify(beerStore)
    expect(out.budLightTotalInclTax).toBe(54.37)
    expect(out.recomputeBasis).toBe('lines_all_bud_light')
    expect(out.status).toBe('auto_pass')
  })

  it('a tax line the model ticked as Bud Light is not grossed up a second time', () => {
    const ticked = {
      subtotal: 45.99, tax: 5.98, grand_total: 54.37, bud_light_total_incl_tax: 51.97,
      lines: [bl('BUD LIGHT 355ML 24UC CA', 45.99), other('DEPOSIT', 2.4), bl('HST', 5.98)]
    }
    expect(recomputeBudLightTotal(ticked as never).total).toBe(54.37)
  })
})
