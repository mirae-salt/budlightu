/**
 * One rule for every "why are you doing this?" field.
 *
 * These gate the actions that move money or change who gets paid: voiding an
 * invoice, deciding or reopening a receipt, editing invoice lines, requesting a
 * banking change, rejecting an onboarding submission. The text is what lands in
 * `audit_log`, so it has to exist.
 *
 * It was six different rules with six different minimums (1, 3, 3, 4, 5, 5),
 * scattered across routes and pages, and most of them only greyed a button out or
 * returned a bare 400. The only way to discover the requirement was to guess. A
 * blocked control that will not say why is a dead end, and the inconsistency meant
 * the same word was accepted in one place and refused in another.
 *
 * The minimum is deliberately short. Ten characters rejected honest answers like
 * "typo" and "wrong bank". What matters is that the field is not blank, not that
 * it is long.
 */

export const MIN_REASON_LENGTH = 3
export const MAX_REASON_LENGTH = 1000

/**
 * Returns a sentence explaining what is wrong, or null when the reason is usable.
 * Use the SAME function on the server and in the UI so the message a person sees
 * before submitting matches the one they would get after.
 *
 * `label` names the field in the message, e.g. "Reason for voiding".
 */
export function reasonProblem(raw: unknown, label = 'Reason'): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return `${label} is required. Say briefly why, so it is on the record.`
  }
  const trimmed = raw.trim()
  if (trimmed.length < MIN_REASON_LENGTH) {
    return `${label} is too short. Use at least ${MIN_REASON_LENGTH} characters, for example "typo".`
  }
  if (trimmed.length > MAX_REASON_LENGTH) {
    return `${label} is too long. Keep it under ${MAX_REASON_LENGTH} characters.`
  }
  return null
}

/** True when the reason passes. Convenience for enabling a button. */
export function reasonOk(raw: unknown): boolean {
  return reasonProblem(raw) === null
}
