/**
 * Turns a stored receipt decision reason into something a person can scan.
 *
 * What gets stored is written for the record, one clause per check, joined with " | ":
 *
 *   bar_restaurant: this is a bar or restaurant receipt, not a retail purchase -- not
 *   eligible for reimbursement | total_mismatch: subtotal($19.00) + tax($2.47) = $21.47
 *   but grand_total is $24.32
 *
 * Rendered as one run-on paragraph, that is a wall. Two separate findings look like one
 * sentence, the machine codes read as noise, and the reader has to parse " | " by eye to
 * work out how many things are actually wrong.
 *
 * THE STORED TEXT IS NOT REWRITTEN. It is the audit record of what the classifier said at
 * the time, and hundreds of rows already hold it. This only changes how it is read.
 *
 * Pure, so the parse can be tested against the real strings the checks produce rather
 * than eyeballed in a table.
 */

/** One finding pulled out of a decision reason. */
export type ReasonPart = {
  /** The machine code, when the clause had one. Null for free text. */
  code: string | null
  /** Short human label for the code. Empty when there is no code. */
  label: string
  /** The explanation, cleaned up for reading. */
  detail: string
}

/*
 * Labels for the codes the checks actually emit, collected from lib/classify-receipt.ts
 * and app/api/receipts/ocr/route.ts. An unknown code is humanised rather than dropped,
 * so a check added later shows up readable without anyone remembering to edit this.
 */
const LABELS: Record<string, string> = {
  bar_restaurant: 'Bar or restaurant',
  delivery_app: 'Delivery app',
  no_store: 'No store name',
  total_mismatch: 'Totals do not add up',
  unreconciled_totals: 'Totals do not reconcile',
  over_balance: 'Over remaining balance',
  over_grand_total: 'Over the receipt total',
  duplicate: 'Duplicate',
  duplicate_across_bams: 'Duplicate from another BAM',
  duplicate_check_unavailable: 'Duplicate check unavailable',
  line_item_contradiction: 'Line items contradict the total',
  mixed_receipt_pretax: 'Mixed receipt',
  near_balance_pattern: 'Clustered near the balance',
  same_store_always: 'Always the same store',
  unreadable_amounts: 'Unreadable amounts',
  unusual_tax: 'Unusual tax rate',
  balance_unknown: 'Balance unknown',
  cohort_unreadable: 'Cohort unreadable',
  cohort_cap_invalid: 'Cohort cap invalid',
  ledger_unreadable: 'Ledger unreadable',
  first_cohort_all_review: 'Review-everything policy',
  low_confidence: 'Low confidence',
  exif_missing: 'No photo metadata',
  price_unreasonable: 'Price looks wrong',
  // The check that wrote this was removed on 2026-09-08; rows still carry it.
  price_outlier: 'Price looks wrong',
  over_cap: 'Over the monthly cap',
  overspend: 'Spent over the cap',
  review_band: 'Close to the monthly cap',
  auto_approved: 'Auto-approved',
  ocr_not_started: 'Could not read this file',
  ocr_failed: 'Could not read this file'
}

/** bar_restaurant -> "Bar restaurant". Last resort, for a code nobody has labelled. */
function humanizeCode(code: string): string {
  const words = code.split('_').join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/*
 * Column and field names that leak into sentences a person reads. Fixed at the source
 * for new receipts, substituted here for the rows that already hold them.
 */
const LEAKED_IDENTIFIERS: Array<[RegExp, string]> = [
  [/\bgrand_total\b/g, 'the receipt total'],
  [/\bbud_light_total_incl_tax\b/g, 'the Bud Light total'],
  [/\breimbursement_max\b/g, 'the monthly cap'],
  // Fixed at the source on 2026-09-08; still on every row written before that.
  [/\bspendable_cap\b/g, 'the monthly cap'],
  [/\bsubtotal\(/g, 'subtotal ('],
  [/\btax\(/g, 'tax (']
]

const upperFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/**
 * Cleans one explanation for reading.
 *
 * " -- " is used in the stored strings as a clause break ("not a retail purchase -- not
 * eligible"). It becomes a full stop, which is what it was standing in for, and each
 * resulting sentence is capitalised: these clauses are written lowercase to sit after a
 * code prefix that is no longer in front of them.
 */
function cleanDetail(text: string): string {
  let s = text.replace(/\s+/g, ' ').trim()
  // "[amount corrected by admin: $179.85 -> $179.85, recomputed from corrected Bud Light
  // lines]" is written even when the amount did not move. Said only when it did.
  s = s.replace(
    /\s*\[amount corrected by admin: (?:\$([\d,]+\.\d{2})|none) -> \$([\d,]+\.\d{2})(?:, recomputed from corrected Bud Light lines)?\]/g,
    (_m, from: string | undefined, to: string) => (from === to ? '' : ` (amount changed from ${from ? `$${from}` : 'nothing'} to $${to})`)
  )
  for (const [pattern, replacement] of LEAKED_IDENTIFIERS) s = s.replace(pattern, replacement)
  return s
    .split(/\s+--\s+/)
    .map(part => upperFirst(part.trim()))
    .filter(Boolean)
    .join('. ')
}

/*
 * What an OCR failure stores is the upstream error verbatim, JSON and all:
 *
 *   ocr_not_started: OCR endpoint returned 500. {"ok":false,"error":"OpenRouter 400:
 *   {\"error\":{\"message\":\"Invalid image data-url\",\"code\":400,...
 *
 * Robin was shown that. It names two vendors she has no relationship with, gives her no
 * idea what went wrong, and runs off the edge of the column. Meanwhile the actual cause
 * of the one on file was that the uploaded file was zero bytes.
 *
 * The raw string stays in the database. It is the audit record, and it is what tells us
 * which vendor failed. This decides what a person is shown in its place.
 */
const OCR_FAILURE_SIGNATURES: Array<[RegExp, string]> = [
  // A data URL with no image behind it. Nearly always an empty or truncated upload.
  [/invalid image data.?url|could not (be )?decode|unsupported image/i,
    'The file did not contain a readable image. Ask them to upload it again.'],
  [/\b(429|rate.?limit|too many requests)\b/i,
    'The reader was busy. Retrying usually works.'],
  [/\b(timeout|timed out|etimedout|deadline)\b/i,
    'The reader took too long to answer. Retrying usually works.'],
  [/\b(413|payload too large|file too large)\b/i,
    'The file was too large for the reader.'],
  [/\b(401|403|unauthorized|forbidden|invalid api key)\b/i,
    'The reader rejected our credentials. This one is on us, not the student.'],
  [/\b5\d\d\b|internal server error|bad gateway|service unavailable/i,
    'The reader failed on its side. Retrying usually works.']
]

/**
 * A short, actionable sentence for a failed read.
 *
 * `storageBytes` wins when it is zero, because that is the cause rather than a symptom
 * and it is the only version that tells someone what to do about it.
 */
export function explainOcrFailure(raw: string, storageBytes?: number | null): string {
  if (storageBytes === 0) {
    return 'The uploaded file is empty (0 bytes). Ask them to upload the receipt again.'
  }
  for (const [pattern, message] of OCR_FAILURE_SIGNATURES) {
    if (pattern.test(raw)) return message
  }
  return 'The reader could not process this file. Try again, or ask them to re-upload it.'
}

/**
 * Shown for every delivery_app finding. The label already says it is a delivery app order, so the
 * line says only what the reviewer has to do. Keep the wording in step with app/api/receipts/ocr/route.ts.
 */
export const DELIVERY_APP_DETAIL = 'Fees and tip are not reimbursed. Count only the Bud Light items and their tax.'

/** "2 line total(s) could not be read as a number -- admin must confirm the amount", said as a task. */
function unreadableAmountsDetail(stored: string): string | null {
  const m = stored.match(/(\d+) line total\(s\) could not be read as a number/)
  if (!m) return null
  const n = Number(m[1])
  return n === 1
    ? '1 line amount could not be read. Check it against the photo.'
    : `${n} line amounts could not be read. Check them against the photo.`
}

/**
 * Splits a stored reason into its findings.
 *
 * A clause is "code: explanation" when it starts with a lower_snake_case token followed
 * by a colon. Anything else is kept whole as free text: several checks write a plain
 * sentence ("No Bud Light items detected on this receipt") and dropping those, or
 * mangling them into a fake code, would lose the only thing the row says.
 */
export function parseReason(
  reason: string | null | undefined,
  opts?: { storageBytes?: number | null }
): ReasonPart[] {
  if (!reason) return []
  return String(reason)
    .split('|')
    .map(s => s.trim())
    .filter(Boolean)
    .map(clause => {
      // Rows written before 2026-10-01 say "meets all auto-pass thresholds (recomputed $62.14
      // from line items)": the name of the check, which tells nobody anything. Same facts,
      // in words. The stored text is left alone.
      const legacy = clause.match(/^meets all auto-pass thresholds \(recomputed \$([\d,]+\.\d{2}) from line items\)\.?$/i)
      if (legacy) {
        return { code: 'auto_approved', label: LABELS.auto_approved, detail: `The Bud Light items on this receipt add up to $${legacy[1]}` }
      }
      const m = clause.match(/^([a-z][a-z0-9_]*):\s*([\s\S]+)$/)
      if (!m) return { code: null, label: '', detail: cleanDetail(clause) }
      const code = m[1]
      const label = LABELS[code] ?? humanizeCode(code)
      // A read that never produced anything is the one case where the stored text is a
      // vendor error rather than a finding, so it is replaced rather than cleaned.
      if (code.startsWith('ocr_')) {
        return { code, label, detail: explainOcrFailure(m[2], opts?.storageBytes) }
      }
      // The stored sentence only says "needs admin review". What the reviewer has to look for is
      // the fees: on the seven real delivery receipts held on 2026-10-07 the total ran $4 to
      // $25 past the items plus tax. Said at read time so the rows already stored get it too.
      if (code === 'delivery_app') return { code, label, detail: DELIVERY_APP_DETAIL }
      if (code === 'unreadable_amounts') {
        const said = unreadableAmountsDetail(m[2])
        if (said) return { code, label, detail: said }
      }
      return { code, label, detail: cleanDetail(m[2]) }
    })
    .filter(p => p.detail.length > 0 || p.label.length > 0)
    // "Auto-approved" is the classifier's own verdict, not a finding. Beside a real finding it
    // reads as the row's status and contradicts the Review badge (Eesha Nandha's Uber Eats
    // receipt, 2026-10-07). The amount it quotes is already in the Bud Light total column.
    .filter((p, _i, all) => !(p.code === 'auto_approved' && all.some(o => o.code !== 'auto_approved')))
}

/** A one-line version, for places with no room for a list. */
export function summarizeReason(reason: string | null | undefined): string {
  const parts = parseReason(reason)
  if (parts.length === 0) return ''
  const first = parts[0].label || parts[0].detail
  return parts.length === 1 ? first : `${first} and ${parts.length - 1} more`
}
