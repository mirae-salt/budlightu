import { ensureInitialsResolved } from './ensure-initials'
import { lookupBank } from './banks'

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
 * The profile a test account is pre-filled with, so an admin can exercise the whole
 * downstream chain (invoice → PDF → AP preview) without first walking onboarding.
 *
 * Every value here is chosen to clear a real gate rather than to look plausible.
 * The gates, and what breaks without them:
 *
 *  street/city/prov/postal  lib/invoice-payload.ts HARD BLOCKS an invoice with an
 *                           incomplete mailing address. Any blank one stops the run.
 *  prov = 'ON'              computeHst() THROWS on a province code outside its table.
 *  bank_name                Must be a displayName from lib/banks.ts, or the roster
 *                           editor rejects it as having an unknown institution number.
 *  institution_no '004'     Must agree with bank_name (TD), or the direct-deposit
 *                           block on the PDF names one bank and routes to another.
 *  transit/account          Written through encrypt_bam_banking, NEVER by a plain
 *                           update: the columns hold base64 pgp_sym_encrypt output,
 *                           so a cleartext write makes decrypt_bam_banking return
 *                           garbage and the invoice HARD BLOCKS on banking.
 *  account_no leading zero  Deliberate. Banking fields are TEXT precisely so a
 *                           leading zero survives; a test account should exercise it.
 *  hst_number = null        Tax is charged only when an HST number exists
 *                           (invoice-payload.ts:154). Most BAMs are students with no
 *                           HST number, so null is the case worth testing by default.
 *                           Set one on the roster to test the taxed variant.
 *
 * These are obviously fake on sight, which matters: a test row must never be
 * mistaken for a real student's banking details.
 */
export const TEST_BAM_PROFILE = {
  phone: '555-555-0100',
  street: '123 Test Street',
  city: 'Test City',
  prov: 'ON',
  postal: 'M5V 1A1',
  school_id: 'Test University',
  bank_name: 'TD Canada Trust',
  consent_ap_cc: true
} as const

/** Banking, applied separately because it must go through the encrypting RPC. */
export const TEST_BAM_BANKING = {
  institution_no: '004',   // TD — must match TEST_BAM_PROFILE.bank_name
  transit_no: '01234',
  account_no: '0123456'    // leading zero on purpose
} as const

/**
 * Fills a test account's profile so the downstream chain is reachable.
 *
 * Only ever fills a field that is EMPTY. It never overwrites a value someone
 * entered, so it is safe to re-run and safe on a row that has been edited by hand.
 * Returns a warning string on failure, never throws.
 */
export async function fillTestBamProfile(db: Db, bamId: string): Promise<string | null> {
  const cols = 'id, cohort_id, phone, street, city, prov, postal, school_id, bank_name, consent_ap_cc, ' +
    'institution_no, transit_no, account_no, email_verified_at, consent_terms_at, consent_terms_version, ' +
    'initials_resolved'
  const { data: rows, error: readErr } = await db.from('bams').select(cols).eq('id', bamId)
  if (readErr) return `Could not read the test account to fill it in: ${readErr.message}`
  if (!rows || rows.length !== 1) return 'Could not find the test account to fill in.'
  const row = rows[0] as Record<string, unknown>

  const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === ''

  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(TEST_BAM_PROFILE)) {
    if (k === 'consent_ap_cc') {
      if (row[k] === null || row[k] === undefined) patch[k] = v
    } else if (blank(row[k])) {
      patch[k] = v
    }
  }
  // Stamped rather than left for a first login: without it the portal bounces the
  // account to /portal/verify-account before it can reach anything. Fair for an
  // admin, whose address is already proven by the admin invite they received.
  if (blank(row.email_verified_at)) patch.email_verified_at = new Date().toISOString()
  if (blank(row.consent_terms_at)) {
    patch.consent_terms_at = new Date().toISOString()
    patch.consent_terms_version = 'test-seed'
  }

  if (Object.keys(patch).length > 0) {
    const { data: updated, error: updErr } = await db
      .from('bams').update(patch).eq('id', bamId).select('id, street, city, prov, bank_name')
    if (updErr) return `Could not fill in the test account: ${updErr.message}`
    // Read-back: an update that matches zero rows reports success.
    if (!updated || updated.length !== 1) return 'The test account fields did not save.'
  }

  // Banking LAST and only when all three are absent: a partial encrypted set would
  // leave the invoice blocked, and overwriting real encrypted values is destructive.
  if (blank(row.institution_no) && blank(row.transit_no) && blank(row.account_no)) {
    // Derive the institution number from THIS row's bank name, not from the
    // constant. bank_name is only filled when it was blank, so a hand-set
    // "RBC Royal Bank" survives — and seeding TD's 004 next to it would recreate
    // exactly the name/number mismatch this file warns about above.
    const bankName = String(row.bank_name ?? TEST_BAM_PROFILE.bank_name)
    const looked = lookupBank(bankName)
    if (!looked) return `Test banking not stored: "${bankName}" is not in the bank lookup.`
    const institutionNo = looked.institutionNo

    const { error: encErr } = await db.rpc('encrypt_bam_banking', {
      p_bam_id: bamId,
      p_institution_no: institutionNo,
      p_transit_no: TEST_BAM_BANKING.transit_no,
      p_account_no: TEST_BAM_BANKING.account_no,
      p_hst_number: null
    })
    if (encErr) return `Test banking could not be stored: ${encErr.message}`

    // Prove it round-trips. Storing cleartext by mistake, or encrypting with a key
    // the reader does not have, both fail HERE rather than at invoice time.
    const { data: dec, error: decErr } = await db.rpc('decrypt_bam_banking', { p_bam_id: bamId })
    if (decErr) return `Test banking was stored but cannot be decrypted: ${decErr.message}`
    const got = Array.isArray(dec) ? dec[0] : dec
    if (
      !got ||
      got.institution_no !== institutionNo ||
      got.transit_no !== TEST_BAM_BANKING.transit_no ||
      got.account_no !== TEST_BAM_BANKING.account_no
    ) {
      return 'Test banking did not round-trip through encryption. The invoice would block on it.'
    }
  }

  // Invoice initials. Without them formatInvoiceNumber throws, so a row that looks
  // complete on the roster still cannot produce an invoice. Older test rows predate
  // the roster route assigning these.
  if (blank(row.initials_resolved) && row.cohort_id) {
    const initials = await ensureInitialsResolved(db, bamId, String(row.cohort_id))
    if (!initials.ok) return `Test invoice initials could not be assigned: ${initials.error}`
  }

  return null
}

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
    const row = existingRows[0] as { id: string; auth_user_id: string | null; is_test: boolean | null }
    if (!row.auth_user_id) {
      const { error: linkErr } = await db
        .from('bams').update({ auth_user_id: opts.userId }).eq('id', row.id)
      if (linkErr) {
        console.error('[ensureTestBam] linking existing bam to admin user failed:', linkErr.message)
        return 'Admin access was granted, but their existing BAM account could not be linked to this login.'
      }
    }
    // Fill a TEST row so the downstream chain is reachable. A real student's row is
    // left alone: seeding fake banking into a participant's record would be a
    // payment error, not a convenience.
    if (row.is_test === true) {
      const fillWarn = await fillTestBamProfile(db, row.id)
      if (fillWarn) {
        console.error('[ensureTestBam] filling existing test bam failed:', fillWarn)
        return `Admin access was granted, but their test BAM account is incomplete: ${fillWarn}`
      }
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

  // Pre-fill address and banking so the admin can run an invoice immediately
  // instead of having to walk onboarding first.
  const fillWarn = await fillTestBamProfile(db, bam.id)
  if (fillWarn) {
    console.error('[ensureTestBam] filling new test bam failed:', fillWarn)
    return `Admin access and a test BAM account were created, but it is not ready to invoice: ${fillWarn}`
  }

  return null
}
