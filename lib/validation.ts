/**
 * Cross-pipeline validation for money-adjacent fields.
 * Mirrors DB CHECK constraints; called defensively before every write / render.
 * A failure = HARD FAIL — block the operation, flag the record.
 */

export const INSTITUTION_REGEX = /^\d{3}$/
export const TRANSIT_REGEX     = /^\d{5}$/
export const ACCOUNT_REGEX     = /^\d{6,12}$/

export function validateInstitution(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !INSTITUTION_REGEX.test(v)) {
    throw new Error(`invalid institution number: ${JSON.stringify(v)} (expected 3 digits, leading zeros preserved)`)
  }
}
export function validateTransit(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !TRANSIT_REGEX.test(v)) {
    throw new Error(`invalid transit number: ${JSON.stringify(v)} (expected 5 digits)`)
  }
}
export function validateAccount(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !ACCOUNT_REGEX.test(v)) {
    throw new Error(`invalid account number: ${JSON.stringify(v)} (expected 6–12 digits)`)
  }
}

export const HST_REGEX = /^\d{9}\s?RT\s?\d{4}$/i
export function isValidHst(v: unknown): boolean {
  return typeof v === 'string' && HST_REGEX.test(v.trim())
}
