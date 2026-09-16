import { describe, it, expect } from 'vitest'
import { classifyReceipt, type ClassifyInput } from '../lib/classify-receipt'

const policy = { reimbursementMax: 150, reviewBandPaddingCad: 10, firstCohortAllReview: false }

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    ocr: {
      store: 'Beer Store', date: '2026-09-05', currency: 'CAD',
      subtotal: 40, tax: 5.2, grand_total: 45.2, overall_confidence: 0.98,
      bud_light_total_incl_tax: 45.2,
      lines: [{ desc: 'Bud Light 12 pack', qty: 1, unit: 40, total: 40, is_bud_light: true, confidence: 1 }]
    },
    spendableCap: 150,
    policy,
    duplicateHash: false,
    lowResolutionHeuristic: false,
    ...over
  } as ClassifyInput
}

describe('late / special-release submissions', () => {
  it('a clean receipt auto-passes when nothing is declared', () => {
    expect(classifyReceipt(input()).status).toBe('auto_pass')
  })

  it('the same receipt goes to review once the BAM declares it special', () => {
    const r = classifyReceipt(input({ lateSubmission: true }))
    expect(r.status).toBe('review')
    expect(r.reason).toMatch(/late_or_special_release/)
  })

  it('a declared receipt is never auto-REJECTED, even with no recognisable Bud Light line', () => {
    // The point of the path: a limited release is exactly the product the model is least
    // likely to recognise, so the receipt the BAM was asked to send is the one that would
    // otherwise be terminally rejected as "No Bud Light items detected".
    const unrecognised = input({
      lateSubmission: true,
      ocr: {
        store: 'Beer Store', date: '2026-09-05', currency: 'CAD',
        subtotal: 40, tax: 5.2, grand_total: 45.2, overall_confidence: 0.98,
        bud_light_total_incl_tax: 0,
        lines: [{ desc: 'BL LMTD EDN SUMMER', qty: 1, unit: 40, total: 40, is_bud_light: false, confidence: 0.9 }]
      }
    } as Partial<ClassifyInput>)
    const r = classifyReceipt(unrecognised)
    expect(r.status).toBe('review')
    expect(r.status).not.toBe('rejected')
  })

  it('the same unrecognised receipt IS rejected when nothing was declared', () => {
    // Shows the previous case is the declaration doing the work, not the fixture.
    const unrecognised = input({
      ocr: {
        store: 'Beer Store', date: '2026-09-05', currency: 'CAD',
        subtotal: 40, tax: 5.2, grand_total: 45.2, overall_confidence: 0.98,
        bud_light_total_incl_tax: 0,
        lines: [{ desc: 'BL LMTD EDN SUMMER', qty: 1, unit: 40, total: 40, is_bud_light: false, confidence: 0.9 }]
      }
    } as Partial<ClassifyInput>)
    expect(classifyReceipt(unrecognised).status).toBe('rejected')
  })

  it('does not read the purchase date: a two-year-old date alone changes nothing', () => {
    // 17 of 109 real receipts carry a year that is not 2026 because the model misread it.
    // Nothing may hang off that field.
    const oldDate = input({
      ocr: { ...input().ocr, date: '2024-09-05' }
    } as Partial<ClassifyInput>)
    expect(classifyReceipt(oldDate).status).toBe('auto_pass')
  })
})
