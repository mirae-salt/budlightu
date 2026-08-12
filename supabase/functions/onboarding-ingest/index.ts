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
 *  2. Rate limit check (3/IP/day, 3/token)
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
import { validateInstitution, validateTransit, validateAccount, isValidHst } from '../../../lib/validation'
import { normalizeBankName, lookupBank } from '../../../lib/banks'
import { normalizeEmail, isValidEmail, cleanText } from '../../../lib/sanitize'
// One source for the version. This file and app/api/onboarding/complete both stamp
// consent_terms_version, and they held separate copies of the string. They agreed --
// until someone edited one, at which point acceptances of the same wording would carry
// different versions and there would be no way to tell which text was accepted.
import { TERMS_VERSION } from '../../../lib/terms'

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
  institution_no: string
  transit_no: string
  account_no: string
  hst_number?: string
  consent_ap_cc: boolean
  consent_terms?: boolean
}

export async function handler(req: {
  invite_token: string
  form: FormPayload
  ip: string
}): Promise<{ ok: boolean; message: string; bam_id?: string }> {
  const db = serviceClient()

  // ── 1. Rate limit (3 per IP per day, P0-3) ────────────────────
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
  if (ipHits >= 3) return { ok: false, message: 'Too many attempts from this network today. Try again tomorrow.' }

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
    if (req.form.hst_number && !isValidHst(req.form.hst_number)) {
      throw new Error('invalid HST number format')
    }
  } catch (e) {
    return { ok: false, message: `Banking info validation failed: ${(e as Error).message}` }
  }

  const bank = lookupBank(req.form.bank_name)
  if (!bank) {
    return { ok: false, message: `Bank "${req.form.bank_name}" not in our lookup. Please contact your program manager.` }
  }

  // An institution number is a property of the BANK, not something a student knows.
  // validateInstitution above only checks the SHAPE (three digits), so a form that
  // said "TD Canada Trust" with institution 703 was stored exactly as submitted: the
  // invoice PDF would then name one bank and route the deposit to another. The
  // lookup table is the authority (lib/banks.ts), so the stored value comes from it.
  //
  // The submitted value is not silently discarded — a disagreement is logged, since
  // a student consistently typing the same "wrong" number is more likely to mean the
  // lookup is wrong for their bank than that they mistyped it.
  const institutionNo = bank.institutionNo
  if (req.form.institution_no !== institutionNo) {
    console.warn(
      `[onboarding-ingest] institution number for "${bank.displayName}" was submitted as ` +
      `${JSON.stringify(req.form.institution_no)}; storing ${institutionNo} from the bank lookup instead.`
    )
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
  const { data: authUser, error: authErr } = await db.auth.admin.createUser({
    email: normEmail,
    email_confirm: true,
    app_metadata: { role: 'bam', bam_id: pendingBam.id },
    user_metadata: { bam_id: pendingBam.id }
  })
  if (authErr || !authUser?.user) {
    return { ok: false, message: `Auth creation failed: ${authErr?.message}` }
  }

  // ── 6. Upsert BAM row (banking via encrypted helper) ──────────
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
    status:       'active',
    auth_user_id: authUser.user.id,
    invite_token_hash: null                // one-time — burn it
  }).eq('id', pendingBam.id)
  if (updErr) return { ok: false, message: `BAM update failed: ${updErr.message}` }

  const { error: encErr } = await db.rpc('encrypt_bam_banking', {
    p_bam_id: pendingBam.id,
    p_institution_no: institutionNo,
    p_transit_no: req.form.transit_no,
    p_account_no: req.form.account_no,
    p_hst_number: req.form.hst_number ?? null
  })
  if (encErr) {
    // Rollback: delete the auth user we just created to avoid orphaned account
    await db.auth.admin.deleteUser(authUser.user.id).catch(() => {})
    // Revert BAM row to pending
    await db.from('bams').update({
      status: 'pending',
      auth_user_id: null,
      invite_token_hash: tokenHash
    }).eq('id', pendingBam.id)
    return { ok: false, message: `Encrypt failed: ${encErr.message}` }
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
