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
  price_unreasonable: 'Price looks wrong'
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
  for (const [pattern, replacement] of LEAKED_IDENTIFIERS) s = s.replace(pattern, replacement)
  return s
    .split(/\s+--\s+/)
    .map(part => upperFirst(part.trim()))
    .filter(Boolean)
    .join('. ')
}

/**
 * Splits a stored reason into its findings.
 *
 * A clause is "code: explanation" when it starts with a lower_snake_case token followed
 * by a colon. Anything else is kept whole as free text: several checks write a plain
 * sentence ("No Bud Light items detected on this receipt") and dropping those, or
 * mangling them into a fake code, would lose the only thing the row says.
 */
export function parseReason(reason: string | null | undefined): ReasonPart[] {
  if (!reason) return []
  return String(reason)
    .split('|')
    .map(s => s.trim())
    .filter(Boolean)
    .map(clause => {
      const m = clause.match(/^([a-z][a-z0-9_]*):\s*([\s\S]+)$/)
      if (!m) return { code: null, label: '', detail: cleanDetail(clause) }
      const code = m[1]
      return { code, label: LABELS[code] ?? humanizeCode(code), detail: cleanDetail(m[2]) }
    })
    .filter(p => p.detail.length > 0 || p.label.length > 0)
}

/** A one-line version, for places with no room for a list. */
export function summarizeReason(reason: string | null | undefined): string {
  const parts = parseReason(reason)
  if (parts.length === 0) return ''
  const first = parts[0].label || parts[0].detail
  return parts.length === 1 ? first : `${first} and ${parts.length - 1} more`
}
