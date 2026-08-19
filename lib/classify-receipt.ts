/**
 * classifyReceipt — pure function mapping OCR output + ledger state to a decision.
 * Consumed by the receipt-ai OCR route and the ocrReceipt edge function.
 *
 * P0-2: uses ledger.spendable_cap (not raw max) for the REVIEW band.
 *
 * P0-F (audit 2026-08-07): the reimbursement amount is NEVER the raw LLM field.
 *   recomputeBudLightTotal() re-derives it from the line items server-side and
 *   that recomputed value is what this function returns (and what gets stored).
 *   Any disagreement with the model's own summary field forces REVIEW.
 *
 * P0-G (audit 2026-08-07): the cap comparison now goes through isInReviewBand(),
 *   so the soft-floor band (reimbursementMax - reviewBandPaddingCad .. cap)
 *   actually routes to Robin. This is touchpoint 1.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */

import type { Policy } from './reimbursement'
import { isInReviewBand } from './reimbursement'
import { round2, parseMoney, parseNonNegativeMoney, parseConfidence } from './money'

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

export type RecomputeBasis =
  | 'lines_incl_tax'      // line totals reconcile to grand_total → already tax-inclusive
  | 'lines_grossed_up'    // ALL lines are Bud Light and reconcile to the pre-tax subtotal → grossed up by the receipt's own tax rate
  | 'lines_mixed_rate_validated' // mixed receipt, reported figure implies a real rate inside the bounds → accepted (F9)
  | 'lines_mixed_pretax'  // mixed receipt on a pre-tax basis → Bud Light PRE-TAX sum kept as-is, always forces REVIEW (F9)
  | 'lines_raw'           // could not reconcile → raw sum of Bud Light lines (always forces REVIEW)

export type RecomputedTotal = {
  /** Server-computed Bud Light total incl. tax. This is the authoritative amount. */
  total: number
  /** What the model claimed in bud_light_total_incl_tax. null = unusable value. */
  modelTotal: number | null
  basis: RecomputeBasis
  /** |modelTotal - total|, null when modelTotal is unusable. */
  mismatchDelta: number | null
  /** true when the model's summary field cannot be trusted → force REVIEW. */
  mismatch: boolean
  /** true when the Bud Light total exceeds the receipt's own grand total → force REVIEW. */
  exceedsGrandTotal: boolean
  /**
   * true when the receipt DOES report subtotal/tax/grand_total but the line
   * totals reconcile to neither → the receipt contradicts itself → force REVIEW.
   * (When those fields are simply absent there is nothing to reconcile against,
   * and the model-vs-recompute cross-check is the remaining guard.)
   */
  unreconciledDespiteTotals: boolean
  /** count of line items whose total could not be read as a number. */
  unparsableLines: number
  /** count of lines classified as Bud Light. */
  budLightLineCount: number
  /** count of parsed lines NOT classified as Bud Light. >0 means a mixed receipt. */
  nonBudLightLineCount: number
  /**
   * F9: true when the receipt is MIXED and its lines are on a pre-tax basis, so the
   * receipt's blended tax rate cannot legitimately be applied to the Bud Light
   * lines. `total` is then the PRE-TAX Bud Light sum and REVIEW is forced.
   */
  mixedPreTax: boolean
  /** Pre-tax sum of the Bud Light lines, before any gross-up. Always populated. */
  budLightPreTax: number
  notes: string[]
}

export type ClassifyOutput = {
  status: 'auto_pass' | 'review' | 'rejected'
  reason: string
  /** Server-recomputed amount. Callers MUST store this, never ocr.bud_light_total_incl_tax. */
  budLightTotalInclTax: number
  /** Kept for the audit trail / admin UI so Robin can see what the model claimed. */
  modelReportedTotal: number | null
  recomputeBasis: RecomputeBasis
  recomputeNotes: string[]
  confidence: number
}

/** Dollars of disagreement between model summary and server recompute that we tolerate. */
export const TOTAL_MISMATCH_TOLERANCE_CAD = 1.0

/** How closely the sum of line totals must land on subtotal / grand_total to pick a basis. */
/**
 * Combined sales-tax rates actually charged in Canada, as of 2026.
 * GST-only 5% · SK 11% · BC 12% · ON 13% · NS 14% (dropped from 15% on 2025-04-01)
 * · QC 14.975% · NB/NL/PE 15%.
 */
const CANADIAN_TAX_RATES = [0.05, 0.11, 0.12, 0.13, 0.14, 0.14975, 0.15]

/** Half a percentage point, to absorb rounding in the OCR'd figures. */
const RATE_TOLERANCE = 0.005

/**
 * On a mixed receipt the beer rate cannot be derived from the receipt alone, only
 * bounded: `blendedRate <= beerRate <= maxRate`. Rather than trust the model's
 * reported tax-inclusive figure (it has been seen to return the receipt's grand
 * total instead), we check whether the rate that figure implies is both inside
 * those bounds and an actual Canadian rate. If it is, the figure is arithmetically
 * corroborated and we can use it; otherwise the caller falls back to the pre-tax
 * sum and forces REVIEW.
 */
function validateModelRate(
  modelValue: unknown,
  blSum: number,
  blendedRate: number,
  maxRate: number
): { total: number; impliedRate: number; matchedRate: number } | null {
  const modelTotal = parseNonNegativeMoney(modelValue)
  if (modelTotal === null || blSum <= 0) return null
  // The tax-inclusive figure can never be below the pre-tax sum.
  if (modelTotal < blSum) return null

  const impliedRate = modelTotal / blSum - 1
  if (impliedRate < blendedRate - RATE_TOLERANCE) return null
  if (impliedRate > maxRate + RATE_TOLERANCE) return null

  const matchedRate = CANADIAN_TAX_RATES.find(r => Math.abs(impliedRate - r) <= RATE_TOLERANCE)
  if (matchedRate === undefined) return null

  return { total: modelTotal, impliedRate, matchedRate }
}

function reconcileTolerance(reference: number): number {
  return Math.max(0.5, Math.abs(reference) * 0.02)
}

/**
 * P0-F (a)(b)(c): re-derive the Bud Light total from the line items.
 *
 * The model is asked for `bud_light_total_incl_tax`, but on a mixed receipt it
 * has been observed to return the receipt's grand total instead ($187 total /
 * $42 of Bud Light → $150 paid out). We therefore never use that field as the
 * amount; we only use it as a cross-check.
 *
 * Line totals on Canadian receipts are usually PRE-tax while the reimbursable
 * amount is measured incl. HST (CLAUDE.md). So we work out which basis the
 * line totals are on by reconciling their sum against the receipt's own
 * subtotal / grand_total, and gross up by the receipt's own tax rate when the
 * lines are pre-tax. If neither reconciles we use the raw sum and force REVIEW.
 *
 * F9 (critic gate 2026-08-07): the gross-up now only runs when EVERY parsed line
 * is Bud Light. `rate = tax / subtotal` is the receipt's BLENDED rate, and beer is
 * fully taxable while groceries are zero-rated, so on a mixed receipt the blend is
 * always too low. Ontario worked example: groceries $50 at 0% + Bud Light $100 at
 * 13% gives subtotal 150, tax 13.00, blended rate 8.67%, so the old code returned
 * $108.67 where the truth is $113.00 — understated by $4.33 on every mixed
 * receipt, AND the model's (correct) $113.00 then tripped the >$1 mismatch rule,
 * so mixed receipts both under-reported and flooded the review queue.
 *
 * Mixed receipts now keep the raw PRE-TAX Bud Light sum ($100.00) and are routed
 * to REVIEW with both figures surfaced, so Robin sets the real amount with
 * `override_total`. Deliberately conservative: the critic confirmed there is no
 * OVER-pay case here, and inventing a provincial rate we did not read off the
 * receipt would create one.
 */
export function recomputeBudLightTotal(ocr: OcrResult | null | undefined): RecomputedTotal {
  const notes: string[] = []
  const rawLines: unknown = ocr?.lines
  const lines: Partial<OcrLine>[] = Array.isArray(rawLines) ? (rawLines as Partial<OcrLine>[]) : []
  if (!Array.isArray(rawLines)) notes.push('ocr.lines is missing or not an array')

  let blSum = 0
  let allSum = 0
  let unparsableLines = 0
  let budLightLineCount = 0
  let nonBudLightLineCount = 0

  for (const l of lines) {
    const t = parseMoney(l?.total)
    if (t === null) {
      unparsableLines++
      if (l?.is_bud_light === true) budLightLineCount++
      else nonBudLightLineCount++
      continue
    }
    allSum = round2(allSum + t)
    if (l?.is_bud_light === true) {
      blSum = round2(blSum + t)
      budLightLineCount++
    } else {
      nonBudLightLineCount++
    }
  }
  if (unparsableLines > 0) {
    notes.push(`${unparsableLines} line total(s) could not be read as a number`)
  }

  const subtotal = parseNonNegativeMoney(ocr?.subtotal)
  const tax = parseNonNegativeMoney(ocr?.tax)
  const grandTotal = parseNonNegativeMoney(ocr?.grand_total)

  const budLightPreTax = blSum

  let basis: RecomputeBasis = 'lines_raw'
  let total = blSum

  if (grandTotal !== null && grandTotal > 0 && Math.abs(allSum - grandTotal) <= reconcileTolerance(grandTotal)) {
    basis = 'lines_incl_tax'
    total = blSum
    notes.push('line totals reconcile to grand_total, so they are already tax-inclusive')
  } else if (
    subtotal !== null && subtotal > 0 && tax !== null &&
    Math.abs(allSum - subtotal) <= reconcileTolerance(subtotal)
  ) {
    const rate = tax / subtotal
    if (nonBudLightLineCount === 0) {
      // Every line is Bud Light, so the receipt's own rate IS the Bud Light rate.
      basis = 'lines_grossed_up'
      total = round2(blSum * (1 + rate))
      notes.push(`every line is Bud Light and the line totals reconcile to the pre-tax subtotal, grossed up by the receipt's own ${(rate * 100).toFixed(2)}% tax rate`)
    } else {
      // F9: mixed receipt. `tax / subtotal` is a BLENDED rate, and beer is always
      // fully taxable while groceries are zero-rated, so the blend is a LOWER bound
      // on the real beer rate. The UPPER bound is `tax / blSum`, which is the rate
      // you get if every non-Bud-Light line were zero-rated and all of the tax on
      // the receipt is attributable to the beer. The true rate lies in between.
      //
      // Bounds alone do not pin it down, so we use them to VALIDATE the model's
      // reported tax-inclusive figure rather than to trust it: accept it only when
      // the rate it implies sits inside those bounds AND matches a real Canadian
      // rate. Both worked examples land correctly:
      //   groceries $50 @0% + BL $100 @13%: bounds [8.67%, 13.00%], model implies
      //     13.00% -> accept $113.00 (the old blended maths gave $108.67)
      //   bread $8 @13% + BL $30 @13%: bounds [13.00%, 16.47%], model implies
      //     13.00% -> accept $33.90
      // Anything outside the bounds, or at a rate that is not a real one, falls
      // through to the pre-tax sum and REVIEW.
      const maxRate = blSum > 0 ? tax / blSum : Infinity
      const validated = validateModelRate(ocr?.bud_light_total_incl_tax, blSum, rate, maxRate)

      if (validated) {
        basis = 'lines_mixed_rate_validated'
        total = validated.total
        notes.push(
          `mixed receipt: ${nonBudLightLineCount} of ${budLightLineCount + nonBudLightLineCount} lines are not Bud Light, ` +
          `so the blended ${(rate * 100).toFixed(2)}% rate is only a lower bound. The reported tax-inclusive figure ` +
          `$${validated.total.toFixed(2)} implies ${(validated.impliedRate * 100).toFixed(2)}%, which is inside the ` +
          `[${(rate * 100).toFixed(2)}%, ${(maxRate * 100).toFixed(2)}%] bound and matches the standard ` +
          `${(validated.matchedRate * 100).toFixed(2)}% rate, so it is accepted.`
        )
      } else {
        basis = 'lines_mixed_pretax'
        total = blSum
        notes.push(
          `mixed receipt: ${nonBudLightLineCount} of ${budLightLineCount + nonBudLightLineCount} lines are not Bud Light. ` +
          `The blended ${(rate * 100).toFixed(2)}% rate is NOT applied because beer is fully taxable while other items ` +
          `may be zero-rated, and the reported tax-inclusive figure does not imply a plausible rate inside the ` +
          `[${(rate * 100).toFixed(2)}%, ${(maxRate * 100).toFixed(2)}%] bound. ` +
          `Reporting the PRE-TAX Bud Light sum of $${blSum.toFixed(2)}; an admin must confirm the tax-inclusive amount.`
        )
      }
    }
  } else {
    notes.push('line totals do not reconcile to subtotal or grand_total, using the raw sum of Bud Light lines')
  }

  if (total < 0) {
    notes.push(`sum of Bud Light lines was negative ($${total.toFixed(2)}), clamped to $0.00`)
    total = 0
  }
  total = round2(total)

  const modelTotal = parseNonNegativeMoney(ocr?.bud_light_total_incl_tax)
  if (modelTotal === null) {
    notes.push('model bud_light_total_incl_tax is missing or not a valid non-negative number')
  }

  const mismatchDelta = modelTotal === null ? null : round2(Math.abs(modelTotal - total))
  const mismatch = modelTotal === null || (mismatchDelta as number) > TOTAL_MISMATCH_TOLERANCE_CAD

  // (b) a Bud Light subtotal cannot exceed what the whole receipt was worth
  const exceedsGrandTotal = grandTotal !== null && grandTotal > 0 && total > round2(grandTotal + 0.01)
  if (exceedsGrandTotal) {
    notes.push(`Bud Light total $${total.toFixed(2)} exceeds the receipt grand total $${grandTotal.toFixed(2)}`)
  }

  const hadTotalsToReconcile =
    (grandTotal !== null && grandTotal > 0) ||
    (subtotal !== null && subtotal > 0 && tax !== null)
  const unreconciledDespiteTotals = basis === 'lines_raw' && hadTotalsToReconcile

  return {
    total,
    modelTotal,
    basis,
    mismatchDelta,
    mismatch,
    exceedsGrandTotal,
    unreconciledDespiteTotals,
    unparsableLines,
    budLightLineCount,
    nonBudLightLineCount,
    mixedPreTax: basis === 'lines_mixed_pretax',
    budLightPreTax,
    notes
  }
}

export function classifyReceipt(input: ClassifyInput): ClassifyOutput {
  const { ocr, policy, duplicateHash, lowResolutionHeuristic } = input

  const rc = recomputeBudLightTotal(ocr)
  const total = rc.total                      // server-recomputed, never the model's field
  const conf = parseConfidence(ocr?.overall_confidence)
  const lines: Partial<OcrLine>[] = Array.isArray(ocr?.lines) ? (ocr.lines as Partial<OcrLine>[]) : []

  const out = (status: ClassifyOutput['status'], reason: string): ClassifyOutput => ({
    status,
    reason,
    budLightTotalInclTax: total,
    modelReportedTotal: rc.modelTotal,
    recomputeBasis: rc.basis,
    recomputeNotes: rc.notes,
    confidence: conf
  })

  // A cap we cannot trust must not be used to auto-approve anything.
  const spendableCap = Number(input.spendableCap)
  if (!Number.isFinite(spendableCap) || spendableCap <= 0) {
    return out('review', `spendable_cap is unusable (${String(input.spendableCap)}) -- cannot auto-decide, admin must confirm`)
  }
  const reimbursementMax = Number.isFinite(policy?.reimbursementMax) ? policy.reimbursementMax : spendableCap
  const padding = Number.isFinite(policy?.reviewBandPaddingCad) ? policy.reviewBandPaddingCad : 0

  // ── Force-REVIEW conditions (any → REVIEW, no auto_pass) ──────────────────

  // P0-G: this safeguard is the first-cohort kill switch. Nothing auto-DECIDES while
  // it is on.
  //
  // CRITIC GATE 2026-08-07 F6: this check used to sit BELOW the zero-Bud-Light
  // branch, so the kill switch stopped auto_pass but not auto-REJECT. A thermal
  // receipt OCR'd as "BJD LIOT" (a real LCBO artifact, see the prompt) classified
  // zero lines as Bud Light and was terminally rejected, costing the student $150,
  // while the setting promised "nothing auto-decides for the first 3 months".
  // Auto-rejection is a money decision and belongs behind the same switch.
  //
  // Nothing below this line runs while the switch is on.
  if (policy.firstCohortAllReview) {
    if (rc.budLightLineCount === 0) {
      return out(
        'review',
        'first_cohort_all_review: no line item was classified as Bud Light, but nothing is auto-rejected ' +
        'while the new-cohort review policy is on -- admin must confirm'
      )
    }
    return out('review', 'first_cohort_all_review: new cohort policy, every receipt is reviewed for the first 3 months')
  }

  // No Bud Light line items at all.
  if (rc.budLightLineCount === 0) {
    if ((rc.modelTotal ?? 0) > 0) {
      // The model claims money but classified nothing as Bud Light — contradiction, never auto-decide.
      return out(
        'review',
        `line_item_contradiction: model reported $${(rc.modelTotal as number).toFixed(2)} of Bud Light but no line item was classified as Bud Light -- admin must confirm`
      )
    }
    return out('rejected', 'No Bud Light items detected on this receipt')
  }

  // F9: mixed receipt on a pre-tax basis. Both figures are surfaced because the
  // amount stored is deliberately the conservative pre-tax one and only Robin can
  // set the true tax-inclusive value (decide + override_total).
  if (rc.mixedPreTax) {
    const claimed = rc.modelTotal === null ? 'no usable figure' : `$${rc.modelTotal.toFixed(2)}`
    return out(
      'review',
      `mixed_receipt_pretax: ${rc.nonBudLightLineCount} of ${rc.budLightLineCount + rc.nonBudLightLineCount} lines are not Bud Light, ` +
      `so this receipt's blended tax rate cannot be applied to the Bud Light lines. ` +
      `Bud Light pre-tax total $${rc.budLightPreTax.toFixed(2)}; the model reported ${claimed} tax-inclusive. ` +
      `Stored the pre-tax figure -- admin must confirm the tax-inclusive amount`
    )
  }

  // P0-F (a): server recompute disagrees with the model's own summary field.
  if (rc.mismatch) {
    const claimed = rc.modelTotal === null ? 'an unusable value' : `$${rc.modelTotal.toFixed(2)}`
    return out(
      'review',
      `total_mismatch: model reported ${claimed} but the line items add up to $${total.toFixed(2)}` +
      `${rc.mismatchDelta !== null ? ` (off by $${rc.mismatchDelta.toFixed(2)})` : ''}` +
      ` -- using the recomputed $${total.toFixed(2)}, admin must confirm`
    )
  }

  if (rc.unparsableLines > 0) {
    return out('review', `unreadable_amounts: ${rc.unparsableLines} line total(s) could not be read as a number -- admin must confirm the amount`)
  }

  if (rc.unreconciledDespiteTotals) {
    return out('review', 'unreconciled_totals: the line items add up to neither the subtotal nor the grand total on this receipt -- admin must confirm the amount')
  }

  // P0-F (b)
  if (rc.exceedsGrandTotal) {
    return out('review', `over_grand_total: Bud Light total $${total.toFixed(2)} exceeds the receipt grand total -- admin must confirm`)
  }

  if (duplicateHash) {
    return out('review', 'duplicate image: the same file was submitted by another BAM this period')
  }
  if (lowResolutionHeuristic) {
    return out('review', 'Low resolution or non-photo image (screenshot, PDF, etc.)')
  }
  if (lines.some(l => l?.ambiguous)) {
    return out('review', 'Some line items could not be clearly identified as Bud Light')
  }
  if (conf < 0.85) {
    return out('review', `Low OCR confidence (${Math.round(conf * 100)}%) -- text may be blurry or partially obscured`)
  }
  for (const l of lines) {
    if (l?.is_bud_light === true && parseConfidence(l?.confidence) < 0.8) {
      return out('review', `Uncertain Bud Light match: "${l?.desc ?? '(no description)'}" (${Math.round(parseConfidence(l?.confidence) * 100)}% confidence)`)
    }
  }

  // P0-G: the REVIEW band, via the shared predicate (previously dead code).
  if (isInReviewBand(total, spendableCap, reimbursementMax, padding)) {
    if (total >= spendableCap) {
      return out('review', `$${total.toFixed(2)} >= spendable_cap $${spendableCap.toFixed(2)} -- at or over the monthly cap, needs admin confirmation`)
    }
    if (total >= reimbursementMax) {
      return out('review', `$${total.toFixed(2)} is at or over the $${reimbursementMax.toFixed(2)} monthly maximum -- needs admin confirmation`)
    }
    const softFloor = round2(Math.min(spendableCap, reimbursementMax) - padding)
    return out('review', `$${total.toFixed(2)} is inside the review band ($${softFloor.toFixed(2)} to $${Math.min(spendableCap, reimbursementMax).toFixed(2)}) -- Robin decides`)
  }

  return out('auto_pass', `meets all auto-pass thresholds (recomputed $${total.toFixed(2)} from line items)`)
}
