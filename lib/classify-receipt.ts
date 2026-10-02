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
  /**
   * The BAM declared this a special or limited release bought outside the normal
   * window (`receipts.late_submission`). Their claim alone sends it to a person.
   *
   * Deliberately NOT derived from `ocr.date`. Measured on 2026-09-16 against 109 real
   * receipts: only 70 carry a purchase date inside their own period, 17 carry a year
   * that is not 2026, and 15 have no readable date. Gating on that field would push a
   * quarter of ordinary receipts into the queue on evidence that is wrong a quarter of
   * the time. Whether the paper actually supports the claim is Robin's call with the
   * image open.
   */
  lateSubmission?: boolean
}

export type RecomputeBasis =
  | 'lines_all_bud_light' // every product is Bud Light → the printed receipt total, exactly what was paid
  | 'lines_deposit_aware' // bottle deposits present and untaxed → taxable Bud Light grossed up, deposit added at face value
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
   * true when our figure IS the receipt's own printed total.
   *
   * The strongest corroboration a receipt can give, because the number was not derived
   * from anything: it is what the till printed and what the card was charged.
   */
  matchesPrintedTotal: boolean
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

/**
 * How far over the monthly cap a receipt can go before a person looks at it anyway.
 *
 * Being over the cap is ordinary and costs nothing, since the cap is what gets paid. Being
 * several times over it is the shape of a misread, and no amount of corroboration makes a
 * figure like that worth paying without someone glancing at the photo.
 *
 * Two is a chosen number, not a derived one. Across the 44 receipts on file on 2026-09-09
 * the largest was 1.36x the cap (a Costco run) and nothing reached 1.5x, so this sits well
 * clear of what students actually buy and stays quiet until something is genuinely odd.
 */
export const OVERSPEND_OUTLIER_MULTIPLE = 2

/** Dollars of disagreement between model summary and server recompute that we tolerate. */
export const TOTAL_MISMATCH_TOLERANCE_CAD = 1.0

/**
 * 1.5%, from two receipts the model got a little wrong in the same way. Maxi's $168.22 was
 * 0.8% off and Roi d'la biere's $178.24 was 1.07% off, both because the model multiplied by
 * a rounded Quebec rate (14%) where the receipts charged 14.975%, and both had a printed
 * total that our figure matched to the cent. A second beer brand tagged by mistake moves the
 * model's figure by far more: a $12 six-pack on a $178 receipt is 6.7%.
 */
const MISMATCH_TOLERANCE_FRACTION = 0.015

/**
 * The same tolerance, widened to a share of the total on a large receipt.
 *
 * The model rounds the tax rate. Asked for the Bud Light total on Maxi's $168.22 receipt
 * it multiplied by 1.14 where the receipt charged 14.975%, and came out $1.35 short once
 * the deposit was allowed for. Nothing was wrong: our figure was the printed total to the
 * cent. A flat dollar cannot tell that from a real disagreement, because the error scales
 * with the receipt. One percent of $150 is $1.50, well under the price of a food item or
 * a second product, which is the mistake this check exists to catch.
 */
function mismatchTolerance(total: number): number {
  return Math.max(TOTAL_MISMATCH_TOLERANCE_CAD, round2(total * MISMATCH_TOLERANCE_FRACTION))
}

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
 * A bottle deposit line.
 *
 * Quebec receipts print the deposit as its own line ("Dépôt", "CONSIGNE 2.40$"), and
 * the deposit is NOT taxed. Read off two real receipts on 2026-09-04:
 *
 *   PETRO-CANADA   BUD LIGHT 45.99 + Dépôt 3.00, TPS 5% = 2.30, TVQ 9.975% = 4.59
 *                  45.99 x 0.05 = 2.30 and 45.99 x 0.09975 = 4.59, so the 3.00 is
 *                  outside the tax base. Total 55.88.
 *   COUCHE-TARD    BUD LIGHT 79.98 + CONSIGNE 4.80 + promo 15.00 - 15.02,
 *                  TPS 4.00 and TVQ 7.98 on 79.96, deposit again outside. Total 96.74.
 *
 * Mixing the deposit into the taxable Bud Light sum is what broke these. It drags the
 * implied rate below the blended lower bound, validateModelRate rejects the figure, and
 * the whole receipt falls back to its PRE-TAX sum. Roman Lombardi lost the entire
 * $12.88 of tax that way.
 *
 * ONTARIO NOTE: LCBO deposits are also untaxed, so this is not a Quebec special case.
 */
const DEPOSIT_PATTERN = /\b(consigne|d[ée]p[oô]ts?|deposits?)\b/i

/**
 * The same thing abbreviated. LCBO prints "DEP 1.20 ea." and BC liquor stores print
 * "Dep $ 1.50", neither of which the word list above catches, so both were read as a
 * second product. That is what made Alexandra Zare's two cases of Bud Light look like a
 * mixed receipt, and it cost her the $2.40 of deposit she paid.
 *
 * A price has to follow. Three letters on their own are too little to act on, and a
 * deposit that is not a charge is not a deposit.
 */
const DEPOSIT_ABBREV = /\bdep\b[\s.:]*\$?\s*\d/i

/**
 * Quebec prints the container's environmental fee as its own line next to the deposit,
 * "Frais l'environnement" on Roi d'la biere's receipt, and it sits outside the tax base
 * the same way the deposit does. Left as a product it made the receipt look mixed, and the
 * amount came out $12.83 under the printed $178.24 until an admin corrected it. With the
 * fees treated as deposits the recompute lands on $178.24 exactly.
 *
 * "BOUT" is Green's Superette's whole line for a bottle deposit. It is matched only as the
 * entire description, because "bouteille" inside a longer line is a product.
 */
const DEPOSIT_ENV_FEE = /\bfrais\s+(?:(?:de\s+)?l['’]\s*|d['’]\s*|de\s+)?environnement\b/i
const DEPOSIT_BOTTLE_ONLY = /^\s*bout\.?\s*$/i

export function isDepositLine(desc: unknown): boolean {
  if (typeof desc !== 'string') return false
  return DEPOSIT_PATTERN.test(desc) || DEPOSIT_ABBREV.test(desc) ||
    DEPOSIT_ENV_FEE.test(desc) || DEPOSIT_BOTTLE_ONLY.test(desc)
}

/**
 * A line that is the receipt's own tax rather than something bought.
 *
 * The model sometimes lists "HST 5.98" as a line item. Read as a second product it turned
 * a Beer Store receipt of nothing but beer into a mixed one and dropped $8.38 from the
 * amount. The whole description has to be a tax name, optionally with a rate, so a product
 * that merely contains the letters is safe.
 */
const TAX_LINE_PATTERN = /^\s*(?:hst|gst|pst|qst|tps|tvq|tvh|tax(?:es)?)\b[\s.:%()\d-]*$/i

export function isTaxLine(desc: unknown): boolean {
  return typeof desc === 'string' && TAX_LINE_PATTERN.test(desc)
}

/**
 * Do the line totals already add up to the printed total?
 *
 * Then the prices on the receipt include the tax, as at the LCBO, and "subtotal plus tax
 * equals total" is the wrong test for it: 33.30 + 3.97 is not 34.50, but the two lines are
 * $17.25 each and the till charged $34.50. Two September LCBO receipts went to an admin
 * for exactly this and were approved untouched.
 *
 * Every line has to be readable, so a receipt with an unreadable line never qualifies.
 */
export function taxIncludedInLines(ocr: OcrResult | null | undefined): boolean {
  const grand = parseNonNegativeMoney(ocr?.grand_total)
  const lines = Array.isArray(ocr?.lines) ? (ocr?.lines as OcrLine[]) : []
  if (grand === null || grand <= 0 || lines.length === 0) return false
  let sum = 0
  for (const l of lines) {
    const t = parseMoney(l?.total)
    if (t === null) return false
    sum = round2(sum + t)
  }
  return Math.abs(sum - grand) <= 0.02
}

/**
 * Does the gap between a receipt's own arithmetic and its printed total look like a
 * deposit that was never itemised?
 *
 * The Beer Store and ACE Liquor print a subtotal and a tax, then a total larger than the
 * two of them, because the container deposit sits outside both and gets no line of its
 * own. Julia Sampogna's receipt reads 93.98 + 12.22 = 106.20 against a printed 112.20,
 * and the missing $6.00 is sixty cans at ten cents. Three receipts in the first week of
 * September were flagged "totals do not add up" for exactly this, and nothing was wrong
 * with any of them.
 *
 * Only a gap in the direction a deposit goes is forgiven. A total SMALLER than subtotal
 * plus tax cannot be a deposit and stays flagged, and so does a gap too large to be one:
 * Eesha Nandha's Uber Eats order runs $20.55 over its own subtotal and tax, which is a
 * delivery fee and a tip, and an admin should see it.
 *
 * The bound is deliberately loose, because this decides whether a person looks at the
 * receipt rather than what anyone is paid. The amount is recomputed from the line items
 * either way, and grandTotalIsSane bounds the printed total separately.
 */
export function depositShapedGap(subtotal: number, tax: number, grandTotal: number): boolean {
  const gap = round2(grandTotal - (subtotal + tax))
  if (gap <= 0) return false
  return gap <= 20 && gap <= grandTotal * 0.12
}

/**
 * A discount, rebate or promo line rather than a thing that was bought.
 *
 * These decide whether a receipt is "mixed". COUCHE-TARD prints a promotion as two
 * lines, CARTE-RABAIS 15.00 and MXM BIERES -15.02, which net to two cents; counting
 * them as other products makes a receipt of nothing but beer look mixed. Metro prints
 * RABAIS -10.00 against the beer.
 *
 * A negative total is a discount whatever it is called, which catches the ones our word
 * list has never seen.
 */
const DISCOUNT_PATTERN = /\b(rabais|remise|discount|promo|promotion|coupon|carte-rabais)\b/i

export function isDiscountLine(desc: unknown, total: number): boolean {
  if (total < 0) return true
  return typeof desc === 'string' && DISCOUNT_PATTERN.test(desc)
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

  /*
   * Deposits are tracked apart from product, because they are not taxed. `allDeposits`
   * is every deposit on the receipt, which is what has to come out of the tax base;
   * `blDeposit` is the part attributable to the Bud Light, which is added back at face
   * value. A deposit counts as Bud Light's when the model marked it so, and also when
   * the only product on the receipt is Bud Light: on a receipt of nothing but beer, the
   * deposit is the beer's whatever the model ticked.
   */
  let allDeposits = 0
  let blDepositMarked = 0
  let blProductCount = 0
  let otherProductCount = 0
  let discountCount = 0
  /** Dollars of discount lines (negative totals), before tax. */
  let discountTaken = 0

  for (const l of lines) {
    const t = parseMoney(l?.total)
    const isBl = l?.is_bud_light === true
    const isDeposit = isDepositLine(l?.desc)

    if (t === null) {
      unparsableLines++
      if (isBl) budLightLineCount++
      else nonBudLightLineCount++
      continue
    }
    allSum = round2(allSum + t)
    // The receipt's own tax is in the sum it reconciles against, but it is not a product
    // and not Bud Light's to gross up again, whatever the model ticked.
    if (isTaxLine(l?.desc)) continue
    if (isBl) {
      blSum = round2(blSum + t)
      budLightLineCount++
    } else {
      nonBudLightLineCount++
    }

    if (isDeposit) {
      allDeposits = round2(allDeposits + t)
      if (isBl) blDepositMarked = round2(blDepositMarked + t)
    } else if (isDiscountLine(l?.desc, t)) {
      // Neither a product nor a deposit. Counting it as another product is what made a
      // beer-only receipt look mixed.
      discountCount++
      if (t < 0) discountTaken = round2(discountTaken - t)
    } else if (isBl) {
      blProductCount++
    } else {
      otherProductCount++
    }
  }

  /** Nothing but Bud Light was bought, so every deposit on it is Bud Light's. */
  const allProductIsBudLight = blProductCount > 0 && otherProductCount === 0
  const blDeposit = allProductIsBudLight ? allDeposits : blDepositMarked
  /** The Bud Light that tax actually applies to: product only, deposits removed. */
  const blTaxable = round2(blSum - blDepositMarked)
  if (unparsableLines > 0) {
    notes.push(`${unparsableLines} line total(s) could not be read as a number`)
  }

  const subtotal = parseNonNegativeMoney(ocr?.subtotal)
  const tax = parseNonNegativeMoney(ocr?.tax)
  const grandTotal = parseNonNegativeMoney(ocr?.grand_total)

  const budLightPreTax = blSum

  let basis: RecomputeBasis = 'lines_raw'
  let total = blSum

  /*
   * Deposit-aware gross-up, added 2026-09-04 after Janet reported that tax was missing
   * from French receipts. Read off the receipts themselves rather than inferred: on both
   * the PETRO-CANADA and COUCHE-TARD photos the printed TPS and TVQ are exactly the
   * rates applied to the product line ALONE, with the deposit outside the base.
   *
   * So the tax base is `subtotal - every deposit`, and the answer is the taxable Bud
   * Light grossed up at that rate, plus the Bud Light deposit back at face value. This
   * runs before the blended-rate reasoning below, because on these receipts there is no
   * blend to reason about: the deposit was never the problem the old bounds were
   * guarding against.
   *
   * Checked against all three receipts held on 2026-09-04:
   *   PETRO-CANADA  45.99 x 1.14975 + 3.00 = 55.88, the printed total
   *   COUCHE-TARD   79.96 x 1.14975 + 4.80 = 96.74, the printed total
   *   MAXI (Isla)   25.69 x 1.14975 + 1.20 = 30.74, on a genuinely mixed receipt
   */
  /*
   * WHOLE RECEIPT IS BUD LIGHT.
   *
   * Then the answer is the printed total and there is nothing to infer: that is what the
   * student paid, tax and deposit and any discount included. Verified against the
   * PETRO-CANADA and COUCHE-TARD photos on 2026-09-04, where 45.99 x 1.14975 + 3.00 and
   * 79.96 x 1.14975 + 4.80 come out at 55.88 and 96.74, the printed totals exactly.
   *
   * Taking the total directly rather than rebuilding it is also the only version that
   * cannot overpay. Grossing up the product and adding the deposit ignores discounts:
   * on Thomas Levesque's Metro receipt, 79.98 grossed up plus 4.80 of deposit is 96.76
   * against a printed total of 85.26, because a RABAIS of -10.00 sits between them. That
   * would have paid out 11.50 more than the student spent.
   */
  /*
   * A sanity band on grand_total before it is trusted as the amount. It has to be at
   * least the sum of the lines, and no more than 30% above it: tax plus deposit cannot
   * plausibly exceed that anywhere in Canada (15% HST plus deposit). A decimal misread
   * turning 55.88 into 552.88 is refused and falls through to the arithmetic below.
   *
   * The gap it DOES allow is the real one: Jake Hooper's Beer Store receipt prints a
   * 43.27 total against 36.96 of lines and 4.81 of tax, because the 1.50 deposit is not
   * itemised anywhere. He paid 43.27 for Bud Light.
   */
  const grandTotalIsSane =
    grandTotal !== null && grandTotal > 0 &&
    grandTotal >= allSum - 0.01 &&
    grandTotal <= round2(allSum * 1.3) + 0.01

  if (allProductIsBudLight && grandTotalIsSane && grandTotal !== null) {
    basis = 'lines_all_bud_light'
    total = grandTotal
    notes.push(
      `every product on this receipt is Bud Light${discountCount > 0 ? ' (the remaining lines are discounts or promotions)' : ''}` +
      `${allDeposits > 0 ? ` plus $${allDeposits.toFixed(2)} of deposit` : ''}, so the amount is the receipt total of $${grandTotal.toFixed(2)}.`
    )
  } else if (
    /*
     * MIXED RECEIPT WITH DEPOSITS.
     *
     * Deposits are not taxed, so the tax base is the subtotal less every deposit. The
     * taxable Bud Light is grossed up at the receipt's own rate and its deposit added
     * back at face value. Mixing the deposit into the taxable sum is what broke these:
     * it drags the implied rate below the blended lower bound, validateModelRate
     * rejects, and the receipt falls back to its PRE-TAX sum.
     */
    allDeposits > 0 &&
    subtotal !== null && subtotal > 0 &&
    tax !== null && tax > 0 &&
    blTaxable > 0 &&
    Math.abs(allSum - subtotal) <= reconcileTolerance(subtotal) &&
    (() => {
      const taxBase = round2(subtotal - allDeposits)
      if (taxBase <= 0) return false
      const r = tax / taxBase
      return CANADIAN_TAX_RATES.some(x => Math.abs(r - x) <= RATE_TOLERANCE)
    })()
  ) {
    const taxBase = round2(subtotal - allDeposits)
    const depositRate = tax / taxBase
    const matched = CANADIAN_TAX_RATES.find(r => Math.abs(depositRate - r) <= RATE_TOLERANCE) as number
    basis = 'lines_deposit_aware'
    const grossed = round2(blTaxable * (1 + matched) + blDeposit)
    // Never above what the receipt says was paid, whatever the arithmetic produces.
    total = grandTotal !== null && grandTotal > 0 ? Math.min(grossed, grandTotal) : grossed
    notes.push(
      `deposits of $${allDeposits.toFixed(2)} are not taxed, so the tax base is $${taxBase.toFixed(2)} ` +
      `and the receipt's own rate is ${(depositRate * 100).toFixed(2)}%, matching the standard ` +
      `${(matched * 100).toFixed(2)}%. Bud Light product $${blTaxable.toFixed(2)} grossed up plus ` +
      `$${blDeposit.toFixed(2)} of deposit at face value.`
    )
  }

  const alreadyAnswered = basis === 'lines_all_bud_light' || basis === 'lines_deposit_aware'

  if (!alreadyAnswered && grandTotal !== null && grandTotal > 0 && Math.abs(allSum - grandTotal) <= reconcileTolerance(grandTotal)) {
    basis = 'lines_incl_tax'
    total = blSum
    notes.push('line totals reconcile to grand_total, so they are already tax-inclusive')
  } else if (
    !alreadyAnswered &&
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
  } else if (!alreadyAnswered) {
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

  /*
   * The model answers a slightly different question than we do, and the difference is
   * the deposit.
   *
   * Asked for the Bud Light total, it returns the product with its tax and leaves the
   * bottle deposit out. We include the deposit, because the student paid it and it is
   * part of the receipt total. So the two figures disagree by exactly the deposit,
   * receipt after receipt, and every one of them tripped the $1 tolerance and went to
   * Robin. Thirteen of the thirty-eight receipts on file on 2026-09-08 were in the queue
   * for this and nothing else, and the amount stored on all thirteen was already right.
   *
   * A disagreement the deposit accounts for is therefore corroboration, not conflict.
   * Anything it does NOT account for still goes to review, which is what catches the case
   * this rule was written for: on Thomas Levesque's Metro receipt a RABAIS of -10.00 sits
   * between the two figures, the deposit does not close the gap, and it is flagged.
   */
  /*
   * A deposit the receipt charges but never itemises.
   *
   * The Beer Store prints DEPOSIT in the summary block with no line of its own, so
   * `allDeposits` is zero and the explanation above cannot fire even though the deposit is
   * plainly there: grand_total minus (subtotal + tax) is exactly it. Basmala Youssef's
   * receipt on 2026-09-09 charged $5.20 that way, and the receipt went to review over a
   * $5.94 disagreement the $5.20 accounts for.
   *
   * This is the same receipt shape that depositShapedGap was written for the day before,
   * for the subtotal-plus-tax check. That fixed one of the two places an unitemised
   * deposit matters and left this one, so the same receipts kept arriving with a different
   * complaint. depositShapedGap is reused rather than re-derived, so the two agree about
   * what counts as deposit-shaped.
   *
   * Only on a receipt of nothing but Bud Light, where the whole deposit is the beer's.
   */
  const impliedDeposit =
    allDeposits === 0 && allProductIsBudLight &&
    subtotal !== null && subtotal > 0 && tax !== null && tax > 0 &&
    grandTotal !== null && grandTotal > 0 &&
    depositShapedGap(subtotal, tax, grandTotal)
      ? round2(grandTotal - (subtotal + tax))
      : 0

  const explainingDeposit = blDeposit > 0 ? blDeposit : impliedDeposit

  /*
   * A discount the model took off and the till did not.
   *
   * Metro prints "Rabais -1.00" among the lines, then a subtotal of 47.99 (the beer 44.99 plus
   * the 3.00 deposit, no rabais in it), 6.74 of tax on the 44.99, and a total of 54.73. The
   * model takes the dollar off before tax and leaves the deposit out, which gives
   * (44.99 - 1.00) x 1.14981 = 50.58, short of the printed total by exactly the deposit plus
   * the discount with its tax. Our figure is the printed total, so nothing is underpaid; the
   * disagreement is the model applying a line the till charged around.
   *
   * Only in this direction (model lower) and only when our figure IS the printed total. The
   * opposite shape is Thomas Levesque's Metro receipt, where the printed total already has
   * the RABAIS in it and the model's figure is higher: that stays flagged, unchanged.
   */
  const productTaxBase = subtotal !== null ? round2(subtotal - allDeposits) : 0
  const effectiveRate = tax !== null && productTaxBase > 0 ? tax / productTaxBase : null
  const explainingDiscount =
    discountTaken > 0 && effectiveRate !== null &&
    grandTotal !== null && Math.abs(total - grandTotal) <= 0.01
      ? round2(discountTaken * (1 + effectiveRate))
      : 0

  // Either explanation is enough, and the deposit alone is tried first: adding the discount to
  // a gap the deposit already closes would push it back out (COUCHE-TARD's promo lines).
  const closesWith = (extra: number) =>
    modelTotal !== null && Math.abs(round2(modelTotal + extra) - total) <= mismatchTolerance(total)
  const depositAloneCloses = explainingDeposit > 0 && closesWith(explainingDeposit)
  const discountToo = !depositAloneCloses && explainingDiscount > 0 && closesWith(explainingDeposit + explainingDiscount)
  const depositExplainsGap = depositAloneCloses || discountToo

  const mismatch =
    modelTotal === null ||
    (!depositExplainsGap && (mismatchDelta as number) > mismatchTolerance(total))

  if (depositExplainsGap && (mismatchDelta as number) > mismatchTolerance(total)) {
    notes.push(
      `the model reported $${(modelTotal as number).toFixed(2)}, which is this total less ` +
      [
        explainingDeposit > 0
          ? `the $${explainingDeposit.toFixed(2)} deposit it leaves out${impliedDeposit > 0 ? ' (charged in the summary, with no line of its own)' : ''}`
          : '',
        discountToo
          ? `the $${discountTaken.toFixed(2)} discount (with its tax, $${explainingDiscount.toFixed(2)}) it took off and the till did not`
          : ''
      ].filter(Boolean).join(' and ') +
      `, so the two agree`
    )
  }

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
    matchesPrintedTotal:
      grandTotal !== null && grandTotal > 0 && Math.abs(total - grandTotal) <= 0.01,
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

  /*
   * A declared special or limited release. Sits at the very top of this section, ABOVE
   * the zero-Bud-Light rejection below, for the same reason the first-cohort switch
   * does: auto-rejection is a money decision.
   *
   * It matters more here than anywhere else. A limited release is precisely the product
   * whose name the model is least likely to recognise as Bud Light, so the receipt the
   * BAM was specifically asked to submit is the one most likely to classify as "No Bud
   * Light items detected" and be terminally rejected. The whole point of this path is
   * that a person looks at it.
   */
  if (input.lateSubmission) {
    return out(
      'review',
      'late_or_special_release: the BAM submitted this as a special or limited release bought ' +
      'outside the normal window -- a program manager confirms the purchase and the amount'
    )
  }

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

  /*
   * P0-G: the REVIEW band, via the shared predicate (previously dead code).
   *
   * These three sentences are what a program manager reads before deciding, so they say
   * what she is deciding about. The first one used to read "$157.77 >= spendable_cap
   * $150.00", which put a column name on her screen and, worse, left the impression that
   * approving it pays out $157.77. It does not. The amount on the receipt is what the
   * student SPENT; what they are PAID is capped in the ledger
   * (lib/reimbursement.ts, paidThisMonth = min(spent, spendableCap, capSnapshot)), and
   * the receipt keeps the real figure because Robin needs it to judge a shortfall.
   *
   * So the wording states the cap and says nothing above it is reimbursed, which is true
   * whichever of those three bounds binds. It deliberately does not name a payout figure:
   * this function cannot see capSnapshot, and a sentence that promises a number it cannot
   * check is how the screen starts lying again.
   */
  if (isInReviewBand(total, spendableCap, reimbursementMax, padding)) {
    const cap = Math.min(spendableCap, reimbursementMax)
    const atOrOverCap = total >= spendableCap || total >= reimbursementMax
    const farOverCap = total > round2(cap * OVERSPEND_OUTLIER_MULTIPLE)

    /*
     * OVER THE CAP IS NOT BY ITSELF WORTH A PERSON. Mirae, 2026-09-09.
     *
     * The payment is already bounded: the ledger pays min(spent, cap, snapshot), so a $203
     * receipt reimburses the cap whether or not anybody clicks approve. What the review was
     * still buying was a guard against the other reason a figure lands over the cap, which
     * is the model reading it too high. Past the cap every wrong-high number pays the same
     * amount, so a $20.33 receipt misread as $203.38 would quietly pay the full cap.
     *
     * That guard earns its cost only when the figure is uncorroborated. When our total IS
     * the printed total, a misread would have to corrupt the line items and the printed
     * total to the same wrong value, and corrupting either alone is caught earlier by
     * grandTotalIsSane or exceedsGrandTotal. So a corroborated over-cap receipt clears on
     * its own, and the reason records the overspend so it stays legible afterwards.
     *
     * Corroboration does not cover a figure several times the cap: see
     * OVERSPEND_OUTLIER_MULTIPLE.
     *
     * Nothing announces an over-cap receipt. Robin gets the shortfall alert and asked for
     * no equivalent here, because the cap is a rule rather than an exception to chase.
     */
    if (atOrOverCap && rc.matchesPrintedTotal && !farOverCap) {
      return out(
        'auto_pass',
        `overspend: spent $${total.toFixed(2)}, over the $${cap.toFixed(2)} monthly cap. ` +
        `The receipt's own printed total confirms it, and the cap is what is reimbursed`
      )
    }

    if (farOverCap) {
      return out('review', `overspend: spent $${total.toFixed(2)}, more than ${OVERSPEND_OUTLIER_MULTIPLE} times the $${cap.toFixed(2)} cap -- check the amount is real before the cap is paid`)
    }
    if (atOrOverCap) {
      return out('review', `overspend: spent $${total.toFixed(2)}, over the $${cap.toFixed(2)} cap, and the receipt's own total does not confirm that figure -- check the amount`)
    }
    const softFloor = round2(cap - padding)
    return out('review', `review_band: spent $${total.toFixed(2)}, just under the $${cap.toFixed(2)} cap (anything from $${softFloor.toFixed(2)} is checked) -- a program manager decides`)
  }

  // Written for a person to read on the receipts screen. The old wording, "meets all auto-pass
  // thresholds (recomputed $X from line items)", described the check and not the receipt.
  return out('auto_pass', `auto_approved: the Bud Light items on this receipt add up to $${total.toFixed(2)}`)
}
