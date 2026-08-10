/**
 * Banking correction requests — the rules, separated from the routes.
 *
 * A BAM cannot edit their own banking (a stolen session would redirect a real
 * payment). They submit a REQUEST; an admin applies it. Everything in this file
 * is a pure function so the security-critical decisions are testable without a
 * database: what counts as valid input, when a second request is refused, and
 * whether the admin's type-to-confirm entry matches the requested account.
 *
 * LEADING ZEROS: every banking value here is a string from end to end. There is
 * no Number(), no parseInt(), no arithmetic. "000123456" and "123456" are
 * different accounts and must never compare equal (ENGINEERING-RULES 7.6).
 */
import { validateInstitution, validateTransit, validateAccount } from './validation'
import { lookupBank } from './banks'
import { stripInvisible } from './sanitize'

/**
 * The reason must be present but may be short. Ten characters was arbitrary and
 * rejected real answers ("typo", "wrong bank"), while the form gave no hint about
 * why Send was disabled.
 *
 * Mirrors `bcr_reason_not_empty` in migration 0023. If you change one, change the
 * other: an app that accepts a reason the CHECK rejects fails at insert time.
 */
export const MIN_REASON_LENGTH = 1
/** Hard ceiling so the free-text field cannot be used as storage. */
export const MAX_REASON_LENGTH = 1000

/**
 * Requests a BAM may file in a rolling window, on top of the one-pending rule.
 * Stops a compromised session from cycling submit / get-rejected / submit.
 */
export const MAX_REQUESTS_PER_WINDOW = 5
export const REQUEST_WINDOW_DAYS = 30

export type BankingRequestInput = {
  bank_name: unknown
  institution_no: unknown
  transit_no: unknown
  account_no: unknown
  reason: unknown
}

export type BankingRequestValues = {
  /** Display name resolved through lib/banks.ts. Never the raw typed string. */
  bankName: string
  institutionNo: string
  transitNo: string
  accountNo: string
  reason: string
  /**
   * True when the institution number the BAM typed disagrees with the lookup
   * table for the bank they picked. NOT an error: the number on the void cheque
   * wins (see the note in lib/banks.ts). It is surfaced to Robin as a flag.
   */
  institutionMismatch: boolean
  /** What the lookup table expected, for the admin diff. */
  expectedInstitutionNo: string
}

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string }

/** Trim and remove invisible characters without touching digits. */
function cleanDigits(v: unknown): unknown {
  if (typeof v !== 'string') return v
  return stripInvisible(v).trim()
}

/**
 * Server-side validation for a submitted correction request.
 * Reuses the same validators the invoice pipeline uses, so a request can never
 * carry a value that the invoice engine would later reject.
 */
export function validateBankingRequestInput(input: BankingRequestInput): Validated<BankingRequestValues> {
  const institutionNo = cleanDigits(input.institution_no)
  const transitNo = cleanDigits(input.transit_no)
  const accountNo = cleanDigits(input.account_no)

  try {
    validateInstitution(institutionNo)
    validateTransit(transitNo)
    validateAccount(accountNo)
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }

  if (typeof input.bank_name !== 'string' || input.bank_name.trim() === '') {
    return { ok: false, message: 'Choose your bank from the list.' }
  }
  // Same hard-fail as onboarding: we never guess a routing number.
  const bank = lookupBank(input.bank_name)
  if (!bank) {
    return {
      ok: false,
      message: `Bank "${input.bank_name}" is not in our lookup. Contact your program manager so it can be added.`
    }
  }

  if (typeof input.reason !== 'string') {
    return { ok: false, message: 'Tell us why you need this change.' }
  }
  const reason = stripInvisible(input.reason).trim()
  if (reason.length < MIN_REASON_LENGTH) {
    return { ok: false, message: `Tell us why you need this change (at least ${MIN_REASON_LENGTH} characters).` }
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return { ok: false, message: 'That explanation is too long. Please shorten it.' }
  }

  return {
    ok: true,
    value: {
      bankName: bank.displayName,
      institutionNo: institutionNo as string,
      transitNo: transitNo as string,
      accountNo: accountNo as string,
      reason,
      institutionMismatch: institutionNo !== bank.institutionNo,
      expectedInstitutionNo: bank.institutionNo
    }
  }
}

export type ExistingRequest = { status: string; requested_at: string }

/**
 * Rate limit. Two independent rules:
 *   - one request open at a time (also enforced by a partial unique index)
 *   - at most MAX_REQUESTS_PER_WINDOW in the trailing window
 * A row whose date cannot be parsed counts toward the window: unreadable data
 * must not create head-room (fail closed).
 */
export function checkRequestLimit(
  existing: ExistingRequest[],
  now: Date = new Date()
): Validated<null> {
  if (existing.some(r => r.status === 'pending')) {
    return {
      ok: false,
      message: 'You already have a banking change waiting for review. Your program manager will get to it before anything else can be submitted.'
    }
  }

  const windowStart = now.getTime() - REQUEST_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const inWindow = existing.filter(r => {
    const t = new Date(r.requested_at).getTime()
    return Number.isNaN(t) ? true : t >= windowStart
  })
  if (inWindow.length >= MAX_REQUESTS_PER_WINDOW) {
    return {
      ok: false,
      message: 'Too many banking change requests recently. Please contact your program manager directly.'
    }
  }

  return { ok: true, value: null }
}

/**
 * Type-to-confirm. The admin must re-enter the requested account number by hand
 * before the change is applied, so approving cannot be a reflex click: if a
 * stranger who got into a student's account files a request, Robin has to read
 * and retype the digits she is about to send money to.
 *
 * Exact string comparison. Whitespace and invisible characters are removed
 * (a pasted value can carry a BOM), digits are not. "000123456" never equals
 * "123456".
 */
export function accountConfirmMatches(typed: unknown, requested: unknown): boolean {
  if (typeof typed !== 'string' || typeof requested !== 'string') return false
  const a = stripInvisible(typed).replace(/\s+/g, '')
  const b = stripInvisible(requested).replace(/\s+/g, '')
  if (a === '' || b === '') return false
  return a === b
}

/**
 * The patch written to `bams` when a request is applied.
 *
 * email_verified_at is reset to NULL on purpose. It forces the student back
 * through /portal/verify-account, where they are shown the last 4 digits now on
 * file. That screen is the loop that catches a malicious change: the real
 * student sees digits they do not recognise and reports it, instead of finding
 * out when a payment goes missing. Do not "preserve" this stamp for convenience.
 *
 * The banking columns themselves are NOT in this patch: they are written by the
 * encrypt_bam_banking RPC so they are never stored in plaintext.
 */
export function buildAppliedBamPatch(bankName: string): { bank_name: string; email_verified_at: null } {
  return { bank_name: bankName, email_verified_at: null }
}

/** Last 4 digits for display / audit. Returns null when there is nothing to show. */
export function tail4(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < 4) return null
  return v.slice(-4)
}
