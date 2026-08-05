/**
 * classifyReceipt — pure function mapping OCR output + ledger state to a decision.
 * Consumed by the receipt-ai edge function.
 *
 * P0-2 fix: uses ledger.spendable_cap (not raw max) for the REVIEW band.
 */

import { isInReviewBand } from './reimbursement'
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
      reason: 'first_cohort_all_review policy → all receipts route to human review',
      budLightTotalInclTax: total,
      confidence: conf
    }
  }
  if (duplicateHash) {
    return { status: 'review', reason: 'duplicate file hash across BAMs', budLightTotalInclTax: total, confidence: conf }
  }
  if (lowResolutionHeuristic) {
    return { status: 'review', reason: 'low-resolution / non-receipt heuristic fired', budLightTotalInclTax: total, confidence: conf }
  }
  if (anyAmbiguous) {
    return { status: 'review', reason: 'ambiguous line item(s)', budLightTotalInclTax: total, confidence: conf }
  }
  if (conf < 0.85) {
    return { status: 'review', reason: `overall confidence ${conf} < 0.85`, budLightTotalInclTax: total, confidence: conf }
  }
  for (const l of ocr.lines) {
    if (l.is_bud_light && l.confidence < 0.8) {
      return { status: 'review', reason: `bud_light line confidence ${l.confidence} < 0.80 (${l.desc})`, budLightTotalInclTax: total, confidence: conf }
    }
  }
  // HIGH fix: total at/over the spendable cap ALWAYS goes to review — no auto_pass
  // above the cap, no matter how high the confidence. The cap is $150; claiming
  // $150+ means Robin looks at it.
  if (total >= spendableCap) {
    return {
      status: 'review',
      reason: `total ${total} >= spendable_cap ${spendableCap} — always flagged for review regardless of confidence`,
      budLightTotalInclTax: total,
      confidence: conf
    }
  }

  // Rolling cap AND fresh max bands (near-cap, below the cap itself)
  if (isInReviewBand(total, spendableCap, policy.reimbursementMax, policy.reviewBandPaddingCad)) {
    return {
      status: 'review',
      reason: `total ${total} falls in review band (spendable_cap=${spendableCap}, max=${policy.reimbursementMax}, ±${policy.reviewBandPaddingCad})`,
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
