/**
 * Who may request a sign-in code.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * The decision used to live inline in `app/api/auth/roster-check/route.ts`, which
 * made it impossible to test and impossible to check against live data without
 * calling the endpoint — and calling that endpoint has a side effect: it creates an
 * auth user for a BAM who does not have one yet. So nobody could answer "can Robin
 * sign in?" without either reading the code and guessing, or writing to production.
 *
 * The bug that resulted: the roster was the ONLY gate, so an administrator who is
 * not also on the BAM roster was told "This email is not in our program roster" and
 * could not sign in at all. Robin (super_admin) and Nathan (program_admin) were both
 * locked out. It went unnoticed because the one admin who had logged in
 * (mirae.lee@ilovesalt.com) also happens to have a roster row.
 *
 * Administrators will keep being added, so this is a recurring class rather than one
 * incident. The rule now lives here, `roster-check` calls it, a probe evaluates it
 * against live data read-only, and tests pin it.
 */

/** Statuses that may request a login code. Anything else denies (fail closed). */
export const LOGIN_ALLOWED_STATUSES = ['active', 'pending'] as const

export type GateBamRow = { id: string; auth_user_id: string | null; status: string }

export type GateInput = {
  /** Already normalized (trimmed, lowercased, invisibles stripped). */
  email: string
  /** True when an auth user with this email already holds an admin role claim. */
  isExistingAdmin: boolean
  /** Roster rows matching this email. More than one is a data problem, not a login. */
  bamRows: GateBamRow[]
}

export type GateDecision =
  | { allow: true; as: 'admin' }
  | { allow: true; as: 'bam'; bam: GateBamRow }
  | { allow: false; status: 404 | 403 | 409; reason: 'not_on_roster' | 'status_not_allowed' | 'duplicate_roster'; message: string }

/**
 * Pure. No I/O, so it can be unit tested and evaluated by a read-only probe.
 *
 * Admins are allowed on the strength of an existing `app_metadata` role claim, which
 * only the service role can write. That does not widen the door: the caller must
 * establish that the account ALREADY exists and ALREADY holds an admin role, so this
 * can never create an admin or promote anyone. Students still have to be rostered.
 */
export function signInDecision(input: GateInput): GateDecision {
  if (input.isExistingAdmin) return { allow: true, as: 'admin' }

  if (input.bamRows.length === 0) {
    return {
      allow: false,
      status: 404,
      reason: 'not_on_roster',
      message: 'This email is not in our program roster. Contact your program manager if you think this is a mistake.'
    }
  }

  if (input.bamRows.length > 1) {
    // Should be impossible: there is a unique index on lower(email). Deny rather
    // than pick one at random.
    return {
      allow: false,
      status: 409,
      reason: 'duplicate_roster',
      message: 'Your roster record needs attention. Please contact your program manager.'
    }
  }

  const bam = input.bamRows[0]
  if (!(LOGIN_ALLOWED_STATUSES as readonly string[]).includes(bam.status)) {
    return {
      allow: false,
      status: 403,
      reason: 'status_not_allowed',
      message: 'This account is no longer active. Contact your program manager.'
    }
  }

  return { allow: true, as: 'bam', bam }
}
