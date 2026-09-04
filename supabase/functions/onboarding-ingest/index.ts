/**
 * Edge Function: onboarding-ingest
 * POST {
 *   invite_token: string,           // signed one-time token
 *   form: {
 *     email, first_name, last_name, phone,
 *     street, city, prov, postal, school_id,
 *     bank_name, institution_no, transit_no, account_no, hst_number?, consent_ap_cc
 *   },
 *   ip: string                       // for rate limiting
 * }
 *
 * Flow:
 *  1. Verify invite token → returns bam_id (pending)
 *  2. Rate limit check (per IP per day, see lib/rate-limits.ts; the token itself is
 *     single use, which is the gate that matters)
 *  3. Match email against pending BAM
 *     - Match: encrypt banking, upsert bams, create Supabase Auth user, send OTP, mark active
 *     - No match: park in onboarding_submissions (NO banking fields stored plaintext), notify program admin
 *  4. Return status
 *
 * P0-3 fix: banking fields never stored in onboarding_submissions plaintext.
 * Only encrypted-in-bams if match; discarded if no match.
 */
import { createHash } from 'crypto'
import { serviceClient } from '../_shared/supabase-admin'
import { validateInstitution, validateTransit, validateAccount } from '../../../lib/validation'
import { normalizeBankName, lookupBank, OTHER_BANK, otherBankNameProblem } from '../../../lib/banks'
import { normalizeEmail, isValidEmail, cleanText } from '../../../lib/sanitize'
// One source for the version. This file and app/api/onboarding/complete both stamp
// consent_terms_version, and they held separate copies of the string. They agreed --
// until someone edited one, at which point acceptances of the same wording would carry
// different versions and there would be no way to tell which text was accepted.
import { TERMS_VERSION } from '../../../lib/terms'
import { decideInstitution } from '../../../lib/institution-confirm'
import { ONBOARDING_MAX_PER_IP_PER_DAY } from '../../../lib/rate-limits'
import { validateHstDeclaration } from '../../../lib/hst-declaration'
import { validateAttestations, ATTESTATION_VERSION } from '../../../lib/attestations'

type FormPayload = {
  email: string
  first_name: string
  last_name: string
  phone: string
  street: string
  city: string
  prov: string
  postal: string
  school_id: string
  bank_name: string
  bank_name_other?: string
  institution_no: string
  transit_no: string
  account_no: string
  /**
   * The GST/HST declaration. `hst_number` is only read when hst_status is
   * 'registered'; a 'not_registered' declaration stores no number, which is what
   * keeps tax at $0 through the existing path in lib/invoice-payload.
   */
  hst_status?: string
  hst_number?: string
  hst_attested?: boolean
  consent_ap_cc: boolean
  consent_terms?: boolean
  work_auth?: boolean
  banking_owner?: boolean
  ai_training?: boolean
  /**
   * Set by the form after the student has been shown that their institution number
   * disagrees with our table and has said to use theirs. See lib/institution-confirm.ts.
   */
  institution_confirmed?: boolean
}

export async function handler(req: {
  invite_token: string
  form: FormPayload
  ip: string
}): Promise<{
  ok: boolean
  message: string
  bam_id?: string
  /** Set when the institution number disagrees with our table and we are asking. */
  needsInstitutionConfirm?: boolean
  submittedInstitution?: string
  ourInstitution?: string
}> {
  const db = serviceClient()

  // ── 1. Rate limit (per IP per day, P0-3) ──────────────────────
  // The number lives in lib/rate-limits.ts and NOT here. It was hardcoded to 3, which
  // is right for one person at home and wrong for a room, and because middleware.ts
  // carried a second, higher copy of the same rule, raising the visible one changed
  // nothing while this one kept refusing the fourth person. See that file.
  // P0-H / fail-closed: the count error used to be discarded, so a failed count
  // left `ipHits` undefined, `(undefined ?? 0) >= 3` was false, and the documented
  // limit failed OPEN on exactly the request where the DB was unhealthy. This
  // endpoint is the unauthenticated door to a PII form, so an unknown attempt
  // count must deny.
  const today = new Date().toISOString().slice(0, 10)
  const ipKey = hashUuid(req.ip)
  const { count: ipHits, error: rateErr } = await db
    .from('audit_log')
    .select('*', { count: 'exact', head: true })
    .eq('entity', 'onboarding_ratelimit_ip')
    .eq('entity_id', ipKey)
    .gte('ts', `${today}T00:00:00Z`)
  if (rateErr || ipHits === null || ipHits === undefined) {
    console.error('[onboarding-ingest] rate-limit count failed:', rateErr?.message ?? 'no count returned')
    return { ok: false, message: 'We could not process your submission right now. Please try again in a few minutes.' }
  }
  if (ipHits >= ONBOARDING_MAX_PER_IP_PER_DAY) return { ok: false, message: 'Too many attempts from this network today. Try again tomorrow.' }

  // Log this attempt BEFORE doing any work. If the counter cannot be written the
  // limit is unenforceable for the next request, so refuse rather than proceed.
  const { error: attemptErr } = await db.from('audit_log').insert({
    actor_role: 'bam', entity: 'onboarding_ratelimit_ip',
    entity_id: ipKey, action: 'attempt'
  })
  if (attemptErr) {
    console.error('[onboarding-ingest] rate-limit attempt log failed:', attemptErr.message)
    return { ok: false, message: 'We could not process your submission right now. Please try again in a few minutes.' }
  }

  // ── 2. Verify invite token → pending BAM row ──────────────────
  const tokenHash = createHash('sha256').update(req.invite_token).digest('hex')
  const { data: pendingBam, error: pbErr } = await db
    .from('bams').select('*')
    .eq('invite_token_hash', tokenHash)
    .eq('status', 'pending')
    .single()
  if (pbErr || !pendingBam) {
    return { ok: false, message: 'Invite link is invalid or expired. Please contact your program manager.' }
  }

  // ── 3. Email match check ──────────────────────────────────────
  // P1-6: the same normalizer runs on every read and every write path
  // (`.trim().toLowerCase()` alone leaves U+200B and NBSP behind, and those are
  // invisible in the roster UI). A bad email here is a permanent lockout.
  const normEmail = normalizeEmail(req.form.email)
  if (!isValidEmail(normEmail)) {
    return { ok: false, message: 'That email address does not look valid. Please check it and try again.' }
  }
  if (normalizeEmail(pendingBam.email) !== normEmail) {
    // park in submissions (WITHOUT banking fields)
    // P0-H: this insert's error used to be discarded, so a failed park meant the
    // submission vanished AND nobody was flagged for review.
    const { error: parkErr } = await db.from('onboarding_submissions').insert({
      submitted_email: normEmail,
      form_json_meta: {
        first_name: cleanText(req.form.first_name),
        last_name: cleanText(req.form.last_name),
        street: cleanText(req.form.street),
        city: cleanText(req.form.city),
        prov: cleanText(req.form.prov),
        postal: cleanText(req.form.postal),
        school_id: req.form.school_id,
        bank_name: cleanText(req.form.bank_name)
        // banking / HST intentionally not stored
      },
      status: 'unmatched',
      flag_reason: `email mismatch: form=${normEmail}, roster=${normalizeEmail(pendingBam.email)}`
    })
    if (parkErr) {
      console.error('[onboarding-ingest] failed to park unmatched submission:', parkErr.message)
      return {
        ok: false,
        message: 'The email you entered does not match our records, and we could not file it for review. Please contact your program manager directly.'
      }
    }
    return { ok: false, message: 'The email you entered does not match our records. We have flagged this for review.' }
  }

  // ── 4. Validate banking (HARD FAIL before write) ──────────────
  try {
    validateInstitution(req.form.institution_no)
    validateTransit(req.form.transit_no)
    validateAccount(req.form.account_no)
  } catch (e) {
    return { ok: false, message: `Banking info validation failed: ${(e as Error).message}` }
  }

  // ── 4b. The GST/HST declaration ───────────────────────────────
  // Its own step, not part of banking validation, because it is a statement the
  // contractor makes rather than a field we need in order to pay them. Refused
  // rather than defaulted: a missing answer is not "not registered".
  const attest = validateAttestations({
    workAuth: req.form.work_auth,
    bankingOwner: req.form.banking_owner,
    aiTraining: req.form.ai_training
  })
  if (!attest.ok) return { ok: false, message: attest.error }

  const hst = validateHstDeclaration({
    status: req.form.hst_status,
    number: req.form.hst_number,
    attested: req.form.hst_attested
  })
  if (!hst.ok) {
    return { ok: false, message: hst.message }
  }

  /*
   * "Other" is a real answer, not a failed lookup. The dropdown offered it and this
   * function refused it, so a student whose credit union is not on our list could not
   * finish. With no table entry there is nothing to compare their institution number
   * against, so the cross-check is skipped rather than faked; the form says so on
   * screen. Format checks, leading-zero preservation and encryption are unchanged.
   */
  let bank: { displayName: string; institutionNo: string } | null = null
  let bankIsUnlisted = false

  if (req.form.bank_name === OTHER_BANK) {
    const problem = otherBankNameProblem(req.form.bank_name_other)
    if (problem) return { ok: false, message: problem }
    bank = { displayName: String(req.form.bank_name_other).trim(), institutionNo: '' }
    bankIsUnlisted = true
  } else {
    bank = lookupBank(req.form.bank_name)
    if (!bank) {
      return { ok: false, message: `Bank "${req.form.bank_name}" not in our lookup. Choose "Other" and type the name.` }
    }
  }

  // An institution number is a property of the BANK, not something a student knows.
  // validateInstitution above only checks the SHAPE (three digits), so a form that
  // WHOSE NUMBER WINS: theirs. See lib/institution-confirm.ts for why.
  //
  // An earlier version today discarded what the student typed and stored our table's
  // value instead, warning only to a console log. That routes a student's money by our
  // mistake whenever our table is wrong -- which it has been twice -- and hides the
  // mistake at the same time. Now a disagreement stops the write and asks them, once.
  /*
   * The number that gets stored is the student's own. For a bank on our list a
   * disagreement with the table stops the write and asks them once; for an unlisted
   * bank there is nothing to disagree with, so there is nothing to ask.
   */
  let institutionToStore = req.form.institution_no
  if (!bankIsUnlisted) {
    const decision = decideInstitution({
      bankName: bank.displayName,
      submitted: req.form.institution_no,
      confirmed: req.form.institution_confirmed === true
    })
    if (decision.kind === 'confirm') {
      console.warn(
        `[onboarding-ingest] institution mismatch for "${decision.bankName}": ` +
        `submitted ${decision.submitted}, table has ${decision.ours}. Asking the student.`
      )
      // NOTHING has been written at this point: the auth user is created below.
      return {
        ok: false,
        needsInstitutionConfirm: true,
        submittedInstitution: decision.submitted,
        ourInstitution: decision.ours,
        message: decision.message
      }
    }
    institutionToStore = decision.institutionNo
  }

  // ── 5. Create Supabase Auth user ──────────────────────────────
  // email_confirm: true — we already verified the email matches the roster
  // above (step 3), so Supabase's own "confirm your signup" email would be
  // redundant noise. Login still requires a fresh OTP code (signInWithOtp),
  // this flag only skips the separate confirm-your-address step.
  // P0-A: the role claim goes in `app_metadata`, which only the service role can
  // write. It used to live in `user_metadata`, which the student's own session can
  // rewrite with just the anon key:
  //   await supabase.auth.updateUser({ data: { role: 'super_admin' } })
  // which let any BAM self-promote and read all 58 BAMs' banking details.
  // `bam_id` is mirrored into user_metadata as a legacy convenience only. As of
  // the P0-A sweep nothing reads that copy: server routes use requireBam()
  // (bams.auth_user_id) and the portal pages use lib/portal-bam.ts. It is kept so
  // a session minted before the sweep cannot break, and can be dropped after.
  const { data: created, error: authErr } = await db.auth.admin.createUser({
    email: normEmail,
    email_confirm: true,
    app_metadata: { role: 'bam', bam_id: pendingBam.id },
    user_metadata: { bam_id: pendingBam.id }
  })

  // AN EXISTING AUTH USER IS NOT A FAILURE.
  //
  // This used to return "Auth creation failed: A user with this email address has
  // already been registered" and stop, which is a dead end the student cannot get out
  // of: the invite token is spent by this point, and nothing in the portal will create
  // the link for them. It happens whenever an auth user outlives its roster row --
  // a BAM removed and re-added, a roster row deleted while the login survived, or a
  // second onboarding attempt after a partial failure. It happened for real on
  // 2026-08-12 after a roster row was deleted by hand and re-created.
  //
  // /api/auth/roster-check already handled this case; this path did not. Same shape as
  // there: find the user, link it, and MERGE the claims rather than replacing them, so
  // an admin who is also on the roster is not demoted to 'bam' and locked out of /admin.
  let authUserId: string | null = created?.user?.id ?? null
  // Whether THIS request created the login. The rollback below deletes the auth user,
  // and deleting one we merely linked would destroy a login that predates this attempt --
  // possibly an administrator's.
  const weCreatedTheAuthUser = Boolean(created?.user?.id)

  if (!authUserId) {
    const alreadyExists =
      authErr?.status === 422 ||
      (authErr?.message ?? '').toLowerCase().includes('already')
    if (!alreadyExists) {
      return { ok: false, message: `Auth creation failed: ${authErr?.message}` }
    }

    const { data: listed, error: listErr } = await db.auth.admin.listUsers({ perPage: 1000 })
    if (listErr) {
      return {
        ok: false,
        message: 'We could not finish setting up your login. Please try again, or contact your program manager.'
      }
    }
    const existing = (listed?.users ?? []).find(
      (u: { email?: string | null }) => (u.email ?? '').trim().toLowerCase() === normEmail
    )
    if (!existing) {
      // Supabase said the address is taken but it is not in the list. Do not guess.
      return {
        ok: false,
        message: 'This email already has a login we could not match to your record. Please contact your program manager.'
      }
    }

    // Preserve an admin role instead of overwriting it with 'bam'. The spread keeps any
    // other claim too; only role and bam_id are set here.
    const existingMeta = (existing.app_metadata ?? {}) as Record<string, unknown>
    const existingRole = typeof existingMeta.role === 'string' ? existingMeta.role : null
    const keepAdmin = existingRole === 'super_admin' || existingRole === 'program_admin'

    const { error: linkErr } = await db.auth.admin.updateUserById(existing.id, {
      app_metadata: { ...existingMeta, role: keepAdmin ? existingRole : 'bam', bam_id: pendingBam.id },
      user_metadata: { ...(existing.user_metadata ?? {}), bam_id: pendingBam.id }
    })
    if (linkErr) {
      return {
        ok: false,
        message: 'We could not finish setting up your login. Please try again, or contact your program manager.'
      }
    }
    authUserId = existing.id
  }

  // Shaped like the createUser result so the rest of this function is unchanged, and so
  // the rollback below still has an id to clean up.
  const authUser = { user: { id: authUserId } }

  // ── 6. Upsert BAM row (banking via encrypted helper) ──────────
  const nowIso = new Date().toISOString()
  const { error: updErr } = await db.from('bams').update({
    // P1-6 / rule 7.6: normalize on WRITE, not just on read. `email` is written
    // back in canonical form so a roster row that was created with a trailing
    // space or a pasted capital gets repaired at onboarding time instead of
    // locking the student out later.
    email:        normEmail,
    first_name:   cleanText(req.form.first_name),
    last_name:    cleanText(req.form.last_name),
    phone:        cleanText(req.form.phone),
    street:       cleanText(req.form.street),
    city:         cleanText(req.form.city),
    prov:         cleanText(req.form.prov),
    postal:       cleanText(req.form.postal),
    school_id:    req.form.school_id,
    bank_name:    bank.displayName,
    consent_ap_cc: req.form.consent_ap_cc,
    // The T&C checkbox gated the submit button but was never stored, so there was
    // no record a BAM had agreed to anything. Stamped server-side (never from the
    // client) and versioned so a later revision cannot reinterpret an old accept.
    consent_terms_at: req.form.consent_terms ? new Date().toISOString() : null,
    consent_terms_version: req.form.consent_terms ? TERMS_VERSION : null,
    // The GST/HST declaration, stamped server-side from the validated result rather
    // than from the raw form, so the stored status and the stored number can never
    // disagree. Validated above; `hst` is non-null by the time we get here.
    hst_status: hst.status,
    hst_declared_at: nowIso,
    hst_declaration_version: hst.version,
    // Work authorisation and banking ownership (Shane Deen, 2026-08-27). Stamped
    // server-side from the validated result, like every other consent on this row.
    work_auth_attested_at: nowIso,
    work_auth_version: ATTESTATION_VERSION,
    banking_attested_at: nowIso,
    banking_version: ATTESTATION_VERSION,
    // Optional and refusable, so a "no" is stored as false rather than left looking
    // like a question nobody asked.
    consent_ai_training: attest.aiTraining,
    consent_ai_training_at: attest.aiTraining === null ? null : nowIso,
    consent_ai_training_version: attest.aiTraining === null ? null : ATTESTATION_VERSION,
    status:       'active',
    auth_user_id: authUser.user.id,
    invite_token_hash: null                // one-time — burn it
  }).eq('id', pendingBam.id)
  if (updErr) return { ok: false, message: `BAM update failed: ${updErr.message}` }

  const { error: encErr } = await db.rpc('encrypt_bam_banking', {
    p_bam_id: pendingBam.id,
    p_institution_no: institutionToStore,
    p_transit_no: req.form.transit_no,
    p_account_no: req.form.account_no,
    // From the validated declaration. A 'not_registered' answer sends null, so a
    // number typed and then abandoned when the radio was switched back cannot be
    // stored and cannot later put tax on an invoice.
    p_hst_number: hst.number
  })
  if (encErr) {
    console.error('[onboarding-ingest] encrypt_bam_banking failed for bam', pendingBam.id, encErr.message)

    // ROLLBACK, AND THIS TIME WE CHECK IT.
    //
    // Both of these used to be fire-and-forget: the deleteUser had `.catch(() => {})`
    // and the update had no error binding at all. If the revert failed, the row was left
    // status='active' with NULL banking and a burned invite token -- and the student was
    // told only "Encrypt failed". They could not re-onboard (the token is spent, and the
    // route refuses a non-pending row) and their invoice would HARD BLOCK on missing
    // banking. Nobody would know until the 17th.
    if (weCreatedTheAuthUser) {
      const { error: delErr } = await db.auth.admin.deleteUser(authUser.user.id)
      if (delErr) console.error('[onboarding-ingest] could not delete the new auth user:', delErr.message)
    } else {
      // Linked, not created. Leaving it is the only safe choice: it existed before this
      // request and may be an admin's login.
      console.error('[onboarding-ingest] rolling back a LINKED auth user, leaving it in place:', authUser.user.id)
    }

    const { data: reverted, error: revErr } = await db.from('bams').update({
      status: 'pending',
      auth_user_id: null,
      invite_token_hash: tokenHash
    }).eq('id', pendingBam.id).select('id, status, invite_token_hash')

    // Read back: an update that matches zero rows reports success, and the whole point
    // of this branch is putting the student back where they can try again.
    const row = (reverted ?? [])[0] as { status?: string; invite_token_hash?: string | null } | undefined
    const restored = !revErr && row?.status === 'pending' && Boolean(row?.invite_token_hash)

    if (!restored) {
      console.error(
        '[onboarding-ingest] ROLLBACK FAILED for bam', pendingBam.id,
        revErr?.message ?? `status=${row?.status ?? 'unknown'} token=${row?.invite_token_hash ? 'set' : 'missing'}`
      )
      return {
        ok: false,
        message:
          'We could not save your banking information securely, and we could not undo the ' +
          'partial setup either. Please contact your program manager before trying again ' +
          'so they can reset your invite.'
      }
    }

    return {
      ok: false,
      message:
        'We could not save your banking information securely. Nothing was saved, so please ' +
        'open your invite link again and resubmit. If it keeps failing, contact your ' +
        'program manager.'
    }
  }

  // Note: no email is sent here. `admin.generateLink()` only returns a link/
  // token without emailing it, so calling it added a DB round trip with no
  // effect. The BAM gets their first real login code from the portal login
  // page (`signInWithOtp`), which they're redirected to next.

  return { ok: true, message: 'Onboarding complete. Sign in below to get your login code.', bam_id: pendingBam.id }
}

function hashUuid(s: string): string {
  // deterministic UUID-shaped hash of the IP for rate-limit lookups
  const h = createHash('sha256').update(s).digest('hex').slice(0, 32)
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`
}
