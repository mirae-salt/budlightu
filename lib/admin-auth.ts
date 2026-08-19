/**
 * Server-side authorization for route handlers (P0-A).
 *
 * ONE import, ONE call, fail closed. Use this instead of hand-rolling a
 * `createServerClient` + `user_metadata.role` block in every route.
 *
 *   import { requireAdmin, denied } from '@/lib/admin-auth'
 *
 *   export async function POST(req: NextRequest) {
 *     const auth = await requireAdmin()
 *     if (!auth.ok) return denied(auth)
 *     // auth.userId, auth.role, auth.email are trusted from here on
 *   }
 *
 * Super-admin-only routes use `requireSuperAdmin()`. BAM-scoped routes use
 * `requireBam()`, which resolves the BAM from the database rather than trusting
 * any JWT metadata.
 *
 * Guarantees:
 *  - the role comes from `app_metadata` only (see lib/auth-claims.ts)
 *  - a missing/unreadable env var denies (503) instead of waving traffic through
 *  - the dev bypass needs BOTH NODE_ENV=development AND ALLOW_DEV_AUTH_BYPASS
 *  - a `user_metadata.role` that outranks the trusted claim is logged as tampering
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { serviceClient } from '../supabase/functions/_shared/supabase-admin'
import {
  type AdminRole,
  type KnownRole,
  getRole,
  isAdminRole,
  isSuperAdmin,
  detectRoleTampering
} from './auth-claims'

export {
  type AdminRole,
  type KnownRole,
  ADMIN_ROLES,
  getRole,
  getBamId,
  isAdminRole,
  isSuperAdmin,
  roleClaimPatch
} from './auth-claims'

export type AuthDenied = {
  ok: false
  /** 401 not signed in · 403 signed in but not allowed · 503 server misconfigured */
  status: 401 | 403 | 503
  message: string
}

export type AdminAuthOk = {
  ok: true
  userId: string
  email: string | null
  role: AdminRole
  /** true when the dev bypass produced this result (no real session) */
  devBypass: boolean
}

export type BamAuthOk = {
  ok: true
  userId: string
  email: string | null
  bamId: string
  devBypass: boolean
}

export type AdminAuthResult = AdminAuthOk | AuthDenied
export type BamAuthResult = BamAuthOk | AuthDenied

/** Turn a denial into the response to return. */
export function denied(r: AuthDenied): NextResponse {
  return NextResponse.json({ ok: false, message: r.message }, { status: r.status })
}

export function isDevBypass(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
}

/**
 * Reads the signed-in user from the request cookies.
 * `status` is set when there is no usable user so callers can fail closed.
 */
export async function getSessionUser(): Promise<
  | { ok: true; user: { id: string; email?: string | null; app_metadata?: unknown; user_metadata?: unknown } }
  | AuthDenied
> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Fail CLOSED. A missing env var used to mean "no auth check at all".
  if (!url || !anon) {
    console.error('[admin-auth] Supabase env vars missing. Denying request.')
    return { ok: false, status: 503, message: 'Server is not configured. Contact your program manager.' }
  }

  const cookieStore = await cookies()
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })

  const { data, error } = await supa.auth.getUser()
  if (error || !data?.user) {
    return { ok: false, status: 401, message: 'Not signed in.' }
  }
  return { ok: true, user: data.user }
}

async function requireRole(minimum: 'admin' | 'super_admin'): Promise<AdminAuthResult> {
  if (isDevBypass()) {
    return { ok: true, userId: 'dev', email: null, role: 'super_admin', devBypass: true }
  }

  const session = await getSessionUser()
  if (!session.ok) return session

  const user = session.user
  const role = getRole(user)

  const tamper = detectRoleTampering(user)
  if (tamper.tampered) {
    // Someone wrote a privileged role into the client-writable bag. It is being
    // ignored; record it loudly because it is an attempted escalation.
    console.error(
      `[admin-auth] SECURITY: user ${user.id} carries user_metadata.role="${tamper.claimed}" ` +
      `but the trusted app_metadata role is "${role ?? 'none'}". Ignoring the client claim.`
    )
  }

  const allowed = minimum === 'super_admin' ? isSuperAdmin(role) : isAdminRole(role)
  if (!allowed) {
    return {
      ok: false,
      status: 403,
      message: minimum === 'super_admin' ? 'Super admin only.' : 'You do not have admin access.'
    }
  }

  return { ok: true, userId: user.id, email: user.email ?? null, role: role as AdminRole, devBypass: false }
}

/** program_admin or super_admin. */
export function requireAdmin(): Promise<AdminAuthResult> {
  return requireRole('admin')
}

/** super_admin only (team management, onboarding submissions, AI training pages). */
export function requireSuperAdmin(): Promise<AdminAuthResult> {
  return requireRole('super_admin')
}

/**
 * Resolves the signed-in BAM from the DATABASE (`bams.auth_user_id`), not from
 * any JWT metadata. This is strictly stronger than reading `app_metadata.bam_id`
 * and it needs no backfill: `auth_user_id` is already a system-guarded column.
 *
 * Archived BAMs are denied.
 */
export async function requireBam(): Promise<BamAuthResult> {
  const session = await getSessionUser()
  if (!session.ok) return session

  const user = session.user

  let db
  try {
    db = serviceClient()
  } catch {
    console.error('[admin-auth] service role key missing. Denying request.')
    return { ok: false, status: 503, message: 'Server is not configured. Contact your program manager.' }
  }

  const { data, error } = await db
    .from('bams')
    .select('id, status')
    .eq('auth_user_id', user.id)
    .limit(2)

  if (error) {
    console.error('[admin-auth] bam lookup failed:', error.message)
    return { ok: false, status: 503, message: 'Could not verify your account. Please try again.' }
  }
  if (!data || data.length !== 1) {
    // 0 rows: not a BAM. 2+ rows: data corruption, deny rather than guess.
    if (data && data.length > 1) {
      console.error(`[admin-auth] ${data.length} bams share auth_user_id ${user.id}. Denying.`)
    }
    return { ok: false, status: 403, message: 'No active program account is linked to this login.' }
  }

  const bam = data[0] as { id: string; status: string }
  if (bam.status !== 'active' && bam.status !== 'pending') {
    return { ok: false, status: 403, message: 'This account is no longer active. Contact your program manager.' }
  }

  return { ok: true, userId: user.id, email: user.email ?? null, bamId: bam.id, devBypass: false }
}
