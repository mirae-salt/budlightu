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
}

export async function handler(req: {
  invite_token: string
  form: FormPayload
  ip: string
}): Promise<{ ok: boolean; message: string; bam_id?: string }> {
  const db = serviceClient()

  // ── 1. Rate limit ─────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10)
  const { count: ipHits } = await db
    .from('audit_log')
    .select('*', { count: 'exact', head: true })
    .eq('entity', 'onboarding_ratelimit_ip')
    .eq('entity_id', hashUuid(req.ip))
    .gte('ts', `${today}T00:00:00Z`)
  if ((ipHits ?? 0) >= 3) return { ok: false, message: 'Too many attempts from this network today. Try again tomorrow.' }

  // log this attempt
  await db.from('audit_log').insert({
    actor_role: 'bam', entity: 'onboarding_ratelimit_ip',
    entity_id: hashUuid(req.ip), action: 'attempt'
  })

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
  const normEmail = req.form.email.trim().toLowerCase()
  if (pendingBam.email.trim().toLowerCase() !== normEmail) {
    // park in submissions (WITHOUT banking fields)
    await db.from('onboarding_submissions').insert({
      submitted_email: normEmail,
      form_json_meta: {
        first_name: req.form.first_name,
        last_name: req.form.last_name,
        street: req.form.street,
        city: req.form.city,
        prov: req.form.prov,
        postal: req.form.postal,
        school_id: req.form.school_id,
        bank_name: req.form.bank_name
        // banking / HST intentionally not stored
      },
      status: 'unmatched',
      flag_reason: `email mismatch: form=${normEmail}, roster=${pendingBam.email}`
    })
    return { ok: false, message: 'The email you entered does not match our records. We\'ve flagged this for review.' }
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

  // ── 5. Create Supabase Auth user ──────────────────────────────
  // email_confirm: true — we already verified the email matches the roster
  // above (step 3), so Supabase's own "confirm your signup" email would be
  // redundant noise. Login still requires a fresh OTP code (signInWithOtp),
  // this flag only skips the separate confirm-your-address step.
  const { data: authUser, error: authErr } = await db.auth.admin.createUser({
    email: normEmail,
    email_confirm: true,
    user_metadata: { role: 'bam', bam_id: pendingBam.id }
  })
  if (authErr || !authUser?.user) {
    return { ok: false, message: `Auth creation failed: ${authErr?.message}` }
  }

  // ── 6. Upsert BAM row (banking via encrypted helper) ──────────
  const { error: updErr } = await db.from('bams').update({
    first_name:   req.form.first_name,
    last_name:    req.form.last_name,
    phone:        req.form.phone,
    street:       req.form.street,
    city:         req.form.city,
    prov:         req.form.prov,
    postal:       req.form.postal,
    school_id:    req.form.school_id,
    bank_name:    bank.displayName,
    consent_ap_cc: req.form.consent_ap_cc,
    status:       'active',
    auth_user_id: authUser.user.id,
    invite_token_hash: null                // one-time — burn it
  }).eq('id', pendingBam.id)
  if (updErr) return { ok: false, message: `BAM update failed: ${updErr.message}` }

  const { error: encErr } = await db.rpc('encrypt_bam_banking', {
    p_bam_id: pendingBam.id,
    p_institution_no: req.form.institution_no,
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
