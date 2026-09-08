/**
 * The bottle deposit made the review queue useless.
 *
 * On 2026-09-08 sixteen of the seventeen receipts waiting for Robin said "totals do not
 * add up", and the amount stored on eleven of them was already correct. Two separate
 * rules were firing on deposits, and every case below is a real receipt from that queue.
 */
import { describe, it, expect } from 'vitest'
import {
  isDepositLine,
  depositShapedGap,
  recomputeBudLightTotal,
  classifyReceipt
} from '../lib/classify-receipt'
import { DEFAULT_POLICY } from '../lib/policy'

const policy = { ...DEFAULT_POLICY, firstCohortAllReview: false }

describe('isDepositLine: the abbreviations stores actually print', () => {
  it.each([
    'DEP 1.20 ea.',        // LCBO, Alexandra Zare
    'Dep $ 1.50',          // Blundell Liquor Town, Jaya Punia
    'Dep $ 1.20',
    'Deposit (DEP)',
    'CONSIGNE 3.00$',
    'Dépôt',
    '+Deposit',
    'Container Deposit 36 @ $0.10',
    'DEPOSIT - CANS < 1 LITRE'
  ])('reads "%s" as a deposit', d => expect(isDepositLine(d)).toBe(true))

  it.each([
    'BUD LIGHT 355ML-30PK',
    'LA MARCA PROSECCO DOC',
    'DEPT 7 SUNDRIES',     // "dep" is not a word here
    'DEPILATORY CREAM',
    'Dep'                  // three letters and no charge is not a deposit
  ])('does not read "%s" as a deposit', d => expect(isDepositLine(d)).toBe(false))
})

describe('depositShapedGap: a total larger than its own subtotal plus tax', () => {
  it('forgives the Beer Store, which does not itemise the deposit at all', () => {
    // Julia Sampogna: 60 cans at ten cents, printed nowhere on the receipt.
    expect(depositShapedGap(93.98, 12.22, 112.20)).toBe(true)
  })

  it('forgives ACE Liquor, 24 cans', () => {
    expect(depositShapedGap(71.98, 3.60, 77.98)).toBe(true)
  })

  it('still flags an Uber Eats order, where the gap is a delivery fee and a tip', () => {
    // Eesha Nandha: $20.55 over, which is nobody's deposit.
    expect(depositShapedGap(62.78, 12.20, 95.53)).toBe(false)
  })

  it('still flags a total SMALLER than subtotal plus tax, which no deposit can cause', () => {
    expect(depositShapedGap(100, 13, 108)).toBe(false)
  })
})

describe('the model leaves the deposit out, and that is not a disagreement', () => {
  /** Mackenzie Tomm, Real Canadian Liquorstore, 2026-09-07. */
  const mackenzie = {
    store: 'REAL CANADIAN LIQUORSTORE',
    subtotal: 143.8,
    tax: 6.82,
    grand_total: 150.62,
    bud_light_total_incl_tax: 143.22,   // the product, deposit excluded
    overall_confidence: 1,
    lines: [
      { desc: 'BUD LIGHT 36 CAN GMJ', qty: 2, unit: 62, total: 124, is_bud_light: true, confidence: 1 },
      { desc: 'DEPOSIT 1', qty: 2, unit: 3.6, total: 7.2, is_bud_light: false, confidence: 1 },
      { desc: 'BUD LIGHT 740 ML GMJ', qty: 2, unit: 6.2, total: 12.4, is_bud_light: true, confidence: 1 },
      { desc: 'DEPOSIT 1', qty: 2, unit: 0.1, total: 0.2, is_bud_light: false, confidence: 1 }
    ]
  }

  it('pays the printed total, deposit included', () => {
    expect(recomputeBudLightTotal(mackenzie).total).toBe(150.62)
  })

  it('does not call the missing $7.40 a mismatch', () => {
    const rc = recomputeBudLightTotal(mackenzie)
    expect(rc.mismatchDelta).toBe(7.40)   // the disagreement is still recorded
    expect(rc.mismatch).toBe(false)       // but it is explained, so nobody is asked
    expect(rc.notes.join(' ')).toMatch(/deposit it leaves out/)
  })

  it('a gap the deposit does NOT account for is still flagged', () => {
    // Thomas Levesque's Metro receipt: a RABAIS of -10.00 sits between the two figures,
    // and grossing up the product plus the deposit would have paid him $11.50 too much.
    const withDiscount = {
      ...mackenzie,
      bud_light_total_incl_tax: 120.00,   // neither figure, and the deposit does not bridge it
    }
    expect(recomputeBudLightTotal(withDiscount).mismatch).toBe(true)
  })

  it('still goes to Robin, but for the cap rather than for arithmetic', () => {
    // $150.62 is over the $150 monthly maximum, which is a real reason to look. The
    // point is that "totals do not add up" is no longer one of them.
    const out = classifyReceipt({
      ocr: mackenzie as never,
      spendableCap: 150,
      policy,
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('review')
    expect(out.reason).toMatch(/over_cap/)
    expect(out.reason).not.toMatch(/total_mismatch/)
    expect(out.budLightTotalInclTax).toBe(150.62)
  })

  it('the same receipt under the cap clears without a person', () => {
    /** Lauren Burnett, Safeway Liquor Garneau, 2026-09-07. */
    const lauren = {
      store: 'Safeway Liquor Garneau',
      subtotal: 92.58,
      tax: 4.45,
      grand_total: 97.03,
      bud_light_total_incl_tax: 93.22,
      overall_confidence: 1,
      lines: [
        { desc: 'Bud Light Beer', qty: 1, unit: 51.99, total: 51.99, is_bud_light: true, confidence: 1 },
        { desc: '+Deposit', qty: 1, unit: 2.4, total: 2.4, is_bud_light: false, confidence: 1 },
        { desc: 'Double Lime', qty: 1, unit: 36.99, total: 36.99, is_bud_light: true, confidence: 1 },
        { desc: '+Deposit', qty: 1, unit: 1.2, total: 1.2, is_bud_light: false, confidence: 1 }
      ]
    }
    const out = classifyReceipt({
      ocr: lauren as never,
      spendableCap: 150,
      policy,
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    expect(out.status).toBe('auto_pass')
    expect(out.budLightTotalInclTax).toBe(97.03)
  })
})

describe('an abbreviated deposit no longer makes a beer-only receipt look mixed', () => {
  /** Alexandra Zare, LCBO, 2026-09-05. Tax-inclusive shelf prices, deposit on top. */
  const lcbo = {
    store: 'LCBO',
    subtotal: 63.5,
    tax: 0,
    grand_total: 65.9,
    bud_light_total_incl_tax: 63.5,
    overall_confidence: 0.98,
    lines: [
      { desc: 'BUD LIGHT 12x473', qty: 1, unit: 31.75, total: 31.75, is_bud_light: true, confidence: 0.98 },
      { desc: 'DEP 1.20 ea.', qty: 1, unit: 1.2, total: 1.2, is_bud_light: false, confidence: 0.98 },
      { desc: 'BUD LIGHT 12x473', qty: 1, unit: 31.75, total: 31.75, is_bud_light: true, confidence: 0.98 },
      { desc: 'DEP 1.20 ea.', qty: 1, unit: 1.2, total: 1.2, is_bud_light: false, confidence: 0.98 }
    ]
  }

  it('reads the two DEP lines as deposit, not as a second product', () => {
    const rc = recomputeBudLightTotal(lcbo)
    expect(rc.basis).toBe('lines_all_bud_light')
    expect(rc.total).toBe(65.9)   // she was paid 63.50 and had paid 65.90
  })
})
