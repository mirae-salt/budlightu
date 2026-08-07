import { describe, it, expect } from 'vitest'
import { classifyReceipt } from '../lib/classify-receipt'
import { DEFAULT_POLICY } from '../lib/policy'
const P = { ...DEFAULT_POLICY, firstCohortAllReview: false }

describe('no false-positive review storm on ordinary receipts', () => {
  it('Bud-Light-only receipt, PRE-tax lines, model reports incl-tax total -> auto_pass', () => {
    const ocr = {
      store: 'The Beer Store', date: '2026-08-03',
      lines: [
        { desc: 'BUD LIGHT 12C', qty: 1, unit: 25.95, total: 25.95, is_bud_light: true, confidence: 0.97 },
        { desc: 'BL SELTZER MIX 12X', qty: 1, unit: 28.95, total: 28.95, is_bud_light: true, confidence: 0.95 },
      ],
      subtotal: 54.90, tax: 7.14, grand_total: 62.04,
      bud_light_total_incl_tax: 62.04, overall_confidence: 0.96
    }
    const out = classifyReceipt({ ocr: ocr as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
    console.log('basis:', out.recomputeBasis, 'total:', out.budLightTotalInclTax, 'status:', out.status, '|', out.reason)
    expect(out.status).toBe('auto_pass')
    expect(out.budLightTotalInclTax).toBeCloseTo(62.04, 1)
  })

  it('mixed receipt where the model correctly reports only the BL portion -> auto_pass at the BL amount', () => {
    const ocr = {
      store: 'Loblaws', date: '2026-08-03',
      lines: [
        { desc: 'BUD LIGHT 15C', qty: 1, unit: 30.00, total: 30.00, is_bud_light: true, confidence: 0.98 },
        { desc: 'BREAD', qty: 2, unit: 4.00, total: 8.00, is_bud_light: false, confidence: 0.99 },
      ],
      subtotal: 38.00, tax: 4.94, grand_total: 42.94,
      bud_light_total_incl_tax: 33.90, overall_confidence: 0.97
    }
    const out = classifyReceipt({ ocr: ocr as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
    console.log('basis:', out.recomputeBasis, 'total:', out.budLightTotalInclTax, 'status:', out.status, '|', out.reason)
    expect(out.status).toBe('auto_pass')
    expect(out.budLightTotalInclTax).toBeCloseTo(33.90, 1)
  })

  it('Beer Store receipt with a negative discount line on a BL item', () => {
    const ocr = {
      store: 'The Beer Store', date: '2026-08-03',
      lines: [
        { desc: 'BL TALL CAN 6X', qty: 1, unit: 16.59, total: 16.59, is_bud_light: true, confidence: 0.96 },
        { desc: 'Best Price 1x6=$16.59', qty: 1, unit: -1.35, total: -1.35, is_bud_light: true, confidence: 0.9 },
        { desc: 'DEPOSIT', qty: 1, unit: 0.60, total: 0.60, is_bud_light: false, confidence: 0.99 },
      ],
      subtotal: 15.84, tax: 2.06, grand_total: 18.50,
      bud_light_total_incl_tax: 17.20, overall_confidence: 0.95
    }
    const out = classifyReceipt({ ocr: ocr as any, spendableCap: 150, policy: P, duplicateHash: false, lowResolutionHeuristic: false })
    console.log('basis:', out.recomputeBasis, 'total:', out.budLightTotalInclTax, 'status:', out.status, '|', out.reason)
    expect(out.budLightTotalInclTax).toBeGreaterThan(0)
    expect(out.budLightTotalInclTax).toBeLessThan(19)
  })
})
