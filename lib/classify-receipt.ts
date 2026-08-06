/**
 * classifyReceipt — pure function mapping OCR output + ledger state to a decision.
 * Consumed by the receipt-ai edge function.
 *
 * P0-2 fix: uses ledger.spendable_cap (not raw max) for the REVIEW band.
 */

import type { Policy } from './reimbursement'

export type OcrLine = {
  desc: string
  qty: number
  unit: number
  total: number
  is_bud_light: boolean
  confidence: number
  ambiguous?: boolean
  reason?: string
}

export type OcrResult = {
  store?: string
  date?: string
  currency?: string
  lines: OcrLine[]
  subtotal?: number
  tax?: number
  grand_total?: number
  bud_light_total_incl_tax: number
  overall_confidence: number
  notes?: string
}

export type ClassifyInput = {
  ocr: OcrResult
  spendableCap: number
  policy: Policy
  duplicateHash: boolean        // same sha256 already accepted for another bam this period
  lowResolutionHeuristic: boolean
}

export type ClassifyOutput = {
  status: 'auto_pass' | 'review' | 'rejected'
  reason: string
  budLightTotalInclTax: number
  confidence: number
}

export function classifyReceipt(input: ClassifyInput): ClassifyOutput {
  const { ocr, spendableCap, policy, duplicateHash, lowResolutionHeuristic } = input

  const total = ocr.bud_light_total_incl_tax
  const conf = ocr.overall_confidence
  const anyAmbiguous = ocr.lines.some(l => l.ambiguous)
  const anyLowLineConf = ocr.lines.filter(l => l.is_bud_light).some(l => l.confidence < policy.reviewBandPaddingCad && false)
  // note: reviewBandPaddingCad is CAD padding, not a confidence threshold — kept separate

  // Force-REJECT if no Bud Light detected at all
  if (total === 0 && ocr.lines.every(l => !l.is_bud_light)) {
    return {
      status: 'rejected',
      reason: 'No Bud Light items detected on this receipt',
      budLightTotalInclTax: 0,
      confidence: conf
    }
  }

  // Force-REVIEW conditions (any → REVIEW, no auto_pass)
  if (policy.firstCohortAllReview) {
    return {
      status: 'review',
      reason: 'New cohort policy: all receipts reviewed for the first 3 months',
      budLightTotalInclTax: total,
      confidence: conf
    }
  }
  if (duplicateHash) {
    return { status: 'review', reason: 'Duplicate image: same file was submitted by another BAM this period', budLightTotalInclTax: total, confidence: conf }
  }
  if (lowResolutionHeuristic) {
    return { status: 'review', reason: 'Low resolution or non-photo image (screenshot, PDF, etc.)', budLightTotalInclTax: total, confidence: conf }
  }
  if (anyAmbiguous) {
    return { status: 'review', reason: 'Some line items could not be clearly identified as Bud Light', budLightTotalInclTax: total, confidence: conf }
  }
  if (conf < 0.85) {
    return { status: 'review', reason: `Low OCR confidence (${Math.round(conf * 100)}%) -- text may be blurry or partially obscured`, budLightTotalInclTax: total, confidence: conf }
  }
  for (const l of ocr.lines) {
    if (l.is_bud_light && l.confidence < 0.8) {
      return { status: 'review', reason: `Uncertain Bud Light match: "${l.desc}" (${Math.round(l.confidence * 100)}% confidence)`, budLightTotalInclTax: total, confidence: conf }
    }
  }
  if (total >= spendableCap) {
    return {
      status: 'review',
      reason: `Total $${total.toFixed(2)} meets or exceeds $${spendableCap} cap -- needs admin confirmation`,
      budLightTotalInclTax: total,
      confidence: conf
    }
  }

  return {
    status: 'auto_pass',
    reason: 'meets all auto-pass thresholds',
    budLightTotalInclTax: total,
    confidence: conf
  }
}
