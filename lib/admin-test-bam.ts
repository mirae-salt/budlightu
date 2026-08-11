import { ensureInitialsResolved } from './ensure-initials'

/**
 * Every administrator also gets a TEST BAM account.
 *
 * WHY
 * ---
 * An administrator has to be able to walk the student journey — upload a receipt,
 * see the reimbursement total, look at an invoice — or they cannot check the thing
 * they are approving. Administrators are not on the BAM roster (Robin and Nathan
 * are not students), so without a roster row every portal page shows them an empty
 * state and they cannot test anything.
 *
 * So adding an admin creates a roster row for them too, flagged `is_test = true`.
 *
 * WHY IT MUST BE THE TEST COHORT, AND NOTHING ELSE
 * -----------------------------------------------
 * `is_test` today only relaxes the upload-month rule (lib/period.ts). It does NOT
 * exclude a BAM from invoice generation. So a roster row in a LIVE cohort would be
 * picked up by the monthly run: an invoice for an administrator, with no banking
 * details, addressed to AP. That is a money-and-PII failure, not a cosmetic one.
 *
 * Therefore: the row goes in a cohort named TEST or nowhere. If no test cohort
 * exists, no roster row is created and the caller reports that plainly. An admin
 * with no test account is an inconvenience; an admin invoice sent to AP is not.
 */

/** Only the fields the choice depends on. */
export type CohortChoice = { id: string; name: string | null }

/**
 * Picks the cohort a test BAM row may be created in. Pure, so it is unit tested
 * rather than reasoned about.
 *
 * Fail closed: returns null unless a cohort is unambiguously named as a test
 * cohort. Never "just use the first one" — see the header.
 */
export function chooseTestCohort(cohorts: CohortChoice[]): CohortChoice | null {
  const isTestName = (n: string | null) => {
    const s = (n ?? '').trim().toLowerCase()
    return s === 'test' || s.startsWith('test ') || s.endsWith(' test')
  }
  const matches = cohorts.filter(c => isTestName(c.name))
  // More than one test cohort is ambiguous. Deny rather than guess which one an
  // admin's test data should land in.
  return matches.length === 1 ? matches[0] : null
}

export const NO_TEST_COHORT_WARNING =
  'Admin access was granted, but no test BAM account was created because there is no cohort named TEST. ' +
  'Create one on the Cohorts page, then remove and re-add this admin to give them a test account.'

/** Minimal client shape. Typed loosely for the same reason as lib/portal-bam.ts. */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Db = any

/**
 * Gives an admin a TEST BAM account so they can walk the student journey.
 * See the file header for why this is the test cohort or nothing.
 *
 * Idempotent: safe to call again for an admin who already has a roster row.
 *
 * Never fails the admin grant: the grant is already committed and verified by the
 * time this runs, so undoing it would be a second write with its own failure mode.
 * Returns a warning string instead, which the caller shows to the admin.
 */
export async function ensureTestBam(
  db: Db,
  opts: { userId: string; email: string; firstName: string; lastName: string }
): Promise<string | null> {
  // Already on the roster? Then they are a real BAM (or already have a test row).
  // Link the auth user if it is missing and change NOTHING else — a real student's
  // row must not be relabelled as test data.
  const { data: existingRows, error: existingErr } = await db
    .from('bams').select('id, auth_user_id, is_test').eq('email', opts.email).limit(2)
  if (existingErr) {
    console.error('[ensureTestBam] roster lookup for test account failed:', existingErr.message)
    return 'Admin access was granted, but we could not check whether they already have a BAM account.'
  }
  if (existingRows && existingRows.length > 0) {
    if (existingRows.length > 1) return null // duplicate roster: the sign-in gate reports it
    const row = existingRows[0] as { id: string; auth_user_id: string | null }
    if (row.auth_user_id) return null
    const { error: linkErr } = await db
      .from('bams').update({ auth_user_id: opts.userId }).eq('id', row.id)
    if (linkErr) {
      console.error('[ensureTestBam] linking existing bam to admin user failed:', linkErr.message)
      return 'Admin access was granted, but their existing BAM account could not be linked to this login.'
    }
    return null
  }

  const { data: cohorts, error: cohortErr } = await db.from('cohorts').select('id, name')
  if (cohortErr) {
    console.error('[ensureTestBam] cohort read for test account failed:', cohortErr.message)
    return 'Admin access was granted, but no test BAM account was created because the cohort list could not be read.'
  }
  const cohort = chooseTestCohort((cohorts ?? []) as CohortChoice[])
  if (!cohort) return NO_TEST_COHORT_WARNING

  // status 'active' so the sign-in gate lets them in. Banking and address are left
  // empty on purpose: the portal then routes them through onboarding, which is the
  // student journey they are here to test.
  const { data: inserted, error: insertErr } = await db
    .from('bams')
    .insert({
      cohort_id: cohort.id,
      first_name: opts.firstName,
      last_name: opts.lastName || 'Admin',
      email: opts.email,
      status: 'active',
      is_test: true,
      auth_user_id: opts.userId
    })
    .select('id, email, is_test, cohort_id')

  if (insertErr) {
    console.error('[ensureTestBam] test bam insert failed:', insertErr.message)
    return `Admin access was granted, but their test BAM account could not be created: ${insertErr.message}`
  }
  // Read-back: an insert that reports success but returns no row created nothing.
  if (!inserted || inserted.length !== 1) {
    console.error(`[ensureTestBam] test bam insert returned ${inserted?.length ?? 0} rows`)
    return 'Admin access was granted, but the test BAM account could not be confirmed.'
  }
  const bam = inserted[0] as { id: string; email: string | null; is_test: boolean | null }
  if (bam.email !== opts.email || bam.is_test !== true) {
    console.error(
      `[ensureTestBam] test bam read-back mismatch: email "${String(bam.email)}" is_test ${String(bam.is_test)}`
    )
    return 'Admin access was granted, but the test BAM account was stored incorrectly. Check the roster.'
  }

  // Initials are needed at invoice time, not now. Say so rather than hide it.
  const initials = await ensureInitialsResolved(db, bam.id, cohort.id)
  if (!initials.ok) {
    console.error('[ensureTestBam] initials for test bam failed:', initials.error)
    return 'Admin access and a test BAM account were created, but the test invoice initials could not be assigned.'
  }
  return null
}
