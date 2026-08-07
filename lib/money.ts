/**
 * Money parsing + rounding helpers for the receipt-AI path.
 *
 * Why this file exists (audit 2026-08-07, P0-F c): OCR output is untrusted JSON
 * produced by an LLM. A field the prompt declares as `number` can arrive as
 * "150.00", "$150", "1,150.00", null, NaN or Infinity. Anything that can turn
 * into a reimbursement dollar amount goes through parseMoney() first, so a
 * string never reaches arithmetic and NaN never reaches the ledger.
 *
 * Leading-zero rule (ENGINEERING-RULES 7.6) is unaffected: these helpers are
 * for MONEY only. Institution / transit / account numbers stay strings and must
 * never be passed through here.
 */

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Whitespace + invisible characters to strip, listed as NUMERIC CODE POINTS.
 *
 * Deliberately not a regex with backslash escapes: a literal U+FEFF pasted into
 * source is the exact bug class behind the 2026-08-07 incident, and an escape
 * sequence that gets mangled in transit fails silently (a broken class matches
 * nothing and every amount with a space in it becomes unparseable). Code points
 * cannot be mangled invisibly.
 *
 * tab, LF, VT, FF, CR, space, NBSP, ZWSP, ZWNJ, ZWJ, BOM
 */
const INVISIBLE_CODE_POINTS = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x200b, 0x200c, 0x200d, 0xfeff
])

export function stripInvisibleChars(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined && !INVISIBLE_CODE_POINTS.has(cp)) out += ch
  }
  return out
}

/**
 * Parse an untrusted money value. Returns null when the value is not usable
 * (wrong type, non-numeric text, NaN, Infinity). Negatives are allowed here
 * because receipt line items legitimately go negative (Beer Store volume
 * discounts) - use parseNonNegativeMoney for payable amounts.
 */
export function parseMoney(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? round2(v) : null
  }
  if (typeof v === 'string') {
    const cleaned = stripInvisibleChars(v)
      .replace(/^(CAD|CA)?\$/i, '')
      .replace(/(CAD|CA\$)$/i, '')
      .replace(/,/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? round2(n) : null
  }
  return null
}

/**
 * Same as parseMoney but rejects negatives. Use for any value that can become
 * a payable amount (a reimbursement can never be below zero).
 */
export function parseNonNegativeMoney(v: unknown): number | null {
  const n = parseMoney(v)
  if (n === null || n < 0) return null
  return n
}

/** Confidence is a 0..1 score. Anything unusable becomes 0 (= fails the gate). */
export function parseConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
