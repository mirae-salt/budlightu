/**
 * Whose institution number wins: the student's, or our table's.
 *
 * THE STUDENT'S. Confirmed by Mirae on 2026-08-12, and it is the right call.
 *
 * The number they type is copied off their own void cheque or banking app. Our table is
 * 32 hand-maintained rows that has already been wrong twice: nine credit-union numbers
 * were corrected in one pass, and EQ Bank sat outside it entirely from July until today.
 * Between a student reading their own account details and a list we maintain, the student
 * is the better source.
 *
 * WHAT THIS REPLACES, AND WHY THAT WAS WORSE
 * -----------------------------------------
 * Earlier on 2026-08-12 both onboarding writers were changed to DISCARD the submitted
 * number and store the lookup's instead, with a console warning nobody reads. The
 * reasoning was that an institution number is a property of the bank, which is true, but
 * the conclusion was wrong: it means a student whose bank we have listed incorrectly gets
 * their money routed by our mistake, silently, with no way to tell anyone. It also made
 * our table's errors invisible, which is how they survive.
 *
 * SO: ASK ONCE, THEN BELIEVE THEM.
 *
 * On a mismatch the write does not proceed. The student is shown both numbers and asked
 * to confirm. If they confirm, their number is stored exactly as typed. The disagreement
 * is worth surfacing -- it catches a typo, and when it is not a typo it tells us our table
 * needs fixing -- but it is not worth overruling them over.
 *
 * `validateInstitution` still runs first, so this only ever deals with three digits.
 */
import { lookupBank } from './banks'

export type InstitutionDecision =
  /** Agrees with the table, or the bank is not in it. Store `institutionNo`. */
  | { kind: 'store'; institutionNo: string }
  /**
   * Disagrees. Do not write. Show both numbers and ask. Re-submit with
   * `institution_confirmed: true` to store `submitted`.
   */
  | { kind: 'confirm'; submitted: string; ours: string; bankName: string; message: string }

export function decideInstitution(input: {
  /** displayName from the bank <select>. */
  bankName: string
  /** Exactly what the student typed, already shape-validated. */
  submitted: string
  /** True when they have seen the mismatch and said yes. */
  confirmed?: boolean
}): InstitutionDecision {
  const submitted = String(input.submitted ?? '').trim()

  // Confirmed means confirmed. Checked before the lookup so a second submission cannot
  // be talked out of it by the same disagreement.
  if (input.confirmed) return { kind: 'store', institutionNo: submitted }

  const bank = lookupBank(input.bankName)
  // Not in our table: there is nothing to disagree with, so take theirs. This is the EQ
  // Bank case from July, and the reason no student should be blocked by our list being
  // incomplete.
  if (!bank) return { kind: 'store', institutionNo: submitted }

  if (bank.institutionNo === submitted) return { kind: 'store', institutionNo: submitted }

  return {
    kind: 'confirm',
    submitted,
    ours: bank.institutionNo,
    bankName: bank.displayName,
    message:
      `You entered institution number ${submitted} for ${bank.displayName}, and we have ` +
      `${bank.institutionNo} on file for that bank. Please check the number on your void ` +
      `cheque or in your banking app. If ${submitted} is what it says, confirm and we will ` +
      'use it.'
  }
}
