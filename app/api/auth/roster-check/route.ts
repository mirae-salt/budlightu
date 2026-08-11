/**
 * POST /api/auth/roster-check  { email }
 *
 * Verifies the email exists in the bams roster. If an auth user doesn't exist
 * yet, creates one (Admin API) so signInWithOtp can send a login code.
 * This is the access gate: only rostered BAMs can receive sign-in emails.
 *
 * This route is UNAUTHENTICATED by design (it runs before sign-in), so it is
 * held to the tightest rules in the codebase:
 *
 *  P1-17b (a) It must never grant a privileged claim. It only ever writes
 *             role='bam', and it refuses to downgrade an existing admin.
 *  P1-17b (b) Metadata is MERGED, never replaced. The old code passed a whole
 *             new `user_metadata` object, so an admin who also appeared on the
 *             BAM roster was silently demoted and locked out of /admin.
 *  P1-17b (c) The status gate now checks the values the CHECK constraint
 *             actually allows ('pending','active','archived'). It used to test
 *             for 'inactive', which the constraint forbids, so the gate never
 *             fired once and archived BAMs could still request login codes.
 *  P0-H       Every supabase call's `error` is inspected. supabase-js does not
 *             throw, so an unchecked error is a silent failure.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { parseEmail, normalizeEmail } from '../../../../lib/sanitize'
import { getRole, isAdminRole, roleClaimPatch } from '../../../../lib/auth-claims'
import { signInDecision, type GateBamRow } from '../../../../lib/signin-gate'

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }

  const parsed = parseEmail((body as { email?: unknown } | null)?.email)
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, message: 'Enter a valid email address.' }, { status: 400 })
  }
  const normEmail = parsed.email

  let db
  try {
    db = serviceClient()
  } catch {
    console.error('[roster-check] service client unavailable')
    return NextResponse.json(
      { ok: false, message: 'Sign-in is temporarily unavailable. Please try again shortly.' },
      { status: 503 }
    )
  }

  // An ADMIN is not necessarily on the roster, and the roster is the only gate this
  // route had. Robin is a super_admin with no `bams` row, so she was told "This email
  // is not in our program roster" and could not sign in at all. It went unnoticed
  // because the only admin who had ever logged in also happened to have a BAM row.
  //
  // Existing admins are let through on the strength of their app_metadata claim,
  // which only the service role can write. This does not widen the door: the account
  // must already exist AND already hold an admin role, so nothing here can create an
  // admin or promote anyone. Students still have to be on the roster.
  const { data: userList, error: userErr } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (userErr) {
    console.error('[roster-check] auth user lookup failed:', userErr.message)
    return NextResponse.json(
      { ok: false, message: 'Sign-in is temporarily unavailable. Please try again shortly.' },
      { status: 503 }
    )
  }
  const isExistingAdmin = (userList?.users ?? []).some(
    u => normalizeEmail(u.email ?? '') === normEmail && isAdminRole(getRole(u))
  )

  // The unique index is on lower(email); rows are normalized on write by the
  // trigger in 0016_auth_hardening.sql. Match on the normalized value.
  const { data: bamRows, error: bamErr } = await db
    .from('bams')
    .select('id, auth_user_id, status')
    .eq('email', normEmail)
    .limit(2)

  if (bamErr) {
    console.error('[roster-check] roster lookup failed:', bamErr.message)
    return NextResponse.json(
      { ok: false, message: 'Sign-in is temporarily unavailable. Please try again shortly.' },
      { status: 503 }
    )
  }

  // The rule itself lives in lib/signin-gate.ts so it can be unit tested and checked
  // against live data by scripts/probe/can-sign-in.js without calling this endpoint,
  // which has a side effect (it creates an auth user for an unlinked BAM).
  const decision = signInDecision({
    email: normEmail,
    isExistingAdmin,
    bamRows: (bamRows ?? []) as GateBamRow[]
  })

  if (!decision.allow) {
    if (decision.reason === 'duplicate_roster') {
      console.error(`[roster-check] duplicate roster rows for ${normEmail}. Denying.`)
    }
    return NextResponse.json({ ok: false, message: decision.message }, { status: decision.status })
  }

  // An administrator who is not on the roster stops here: there is no BAM row to
  // create or link, and they already have an auth user by definition.
  if (decision.as === 'admin') {
    return NextResponse.json({ ok: true, role: 'admin' })
  }

  const bam = decision.bam

  // Create or find the auth user if this BAM doesn't have one yet (first-time flow)
  if (!bam.auth_user_id) {
    let authUserId: string | null = null

    const { data: created, error: authErr } = await db.auth.admin.createUser({
      email: normEmail,
      email_confirm: true,
      // Trusted claim. 'bam' is the least-privileged role; this route can never
      // write anything higher.
      app_metadata: { role: 'bam', bam_id: bam.id },
      // Legacy mirror of bam_id. As of the P0-A sweep NOTHING reads this copy:
      // server routes use requireBam() (bams.auth_user_id) and the portal pages
      // use lib/portal-bam.ts (app_metadata claim + DB fallback). Kept only so a
      // browser session minted before the sweep cannot break, and it is not
      // authorization data. Safe to delete once no pre-sweep session is live.
      user_metadata: { bam_id: bam.id }
    })

    if (created?.user) {
      authUserId = created.user.id
    } else if (authErr?.message?.toLowerCase().includes('already') || authErr?.status === 422) {
      // Auth user already exists (prior attempt, or token-based onboarding).
      // Find it and link it WITHOUT clobbering claims it already holds.
      const { data: listed, error: listErr } = await db.auth.admin.listUsers({ perPage: 1000 })
      if (listErr) {
        console.error('[roster-check] listUsers failed:', listErr.message)
        return NextResponse.json(
          { ok: false, message: 'Failed to set up your account. Please try again or contact your program manager.' },
          { status: 503 }
        )
      }

      const existing = (listed?.users ?? []).find(
        (u: { email?: string | null }) => (u.email ?? '').trim().toLowerCase() === normEmail
      )

      if (existing) {
        authUserId = existing.id

        // P1-17b: MERGE. Preserve an existing admin role instead of demoting.
        const existingRole = getRole(existing)
        const nextRole = isAdminRole(existingRole) ? existingRole : 'bam'
        if (isAdminRole(existingRole)) {
          console.warn(
            `[roster-check] ${normEmail} is both an admin (${existingRole}) and on the BAM roster. ` +
            'Keeping the admin role.'
          )
        }

        const { error: updMetaErr } = await db.auth.admin.updateUserById(existing.id, {
          app_metadata: roleClaimPatch(existing.app_metadata, { role: nextRole, bam_id: bam.id }),
          user_metadata: { ...(existing.user_metadata ?? {}), bam_id: bam.id }
        })
        if (updMetaErr) {
          console.error('[roster-check] linking auth user failed:', updMetaErr.message)
          return NextResponse.json(
            { ok: false, message: 'Failed to set up your account. Please try again or contact your program manager.' },
            { status: 500 }
          )
        }
      }
    }

    if (!authUserId) {
      console.error('[roster-check] auth setup failed:', authErr?.message)
      return NextResponse.json(
        { ok: false, message: 'Failed to set up your account. Please try again or contact your program manager.' },
        { status: 500 }
      )
    }

    // P1-17b: this error used to be discarded. If it fails the BAM row stays
    // unlinked, so every later lookup by auth_user_id misses and the student
    // silently cannot upload receipts.
    const { error: linkErr } = await db.from('bams').update({ auth_user_id: authUserId }).eq('id', bam.id)
    if (linkErr) {
      console.error('[roster-check] failed to link auth_user_id on bam', bam.id, linkErr.message)
      return NextResponse.json(
        { ok: false, message: 'Failed to finish setting up your account. Please contact your program manager.' },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ ok: true })
}
