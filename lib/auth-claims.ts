/**
 * P0-A: the ONLY place the codebase is allowed to read an authorization claim.
 *
 * Why this file exists
 * --------------------
 * Every authorization decision used to read `user_metadata.role`. Supabase's
 * `user_metadata` is writable by the user's own session with nothing but the
 * anon key:
 *
 *     await supabase.auth.updateUser({ data: { role: 'super_admin' } })
 *
 * BAMs are created with `user_metadata:{role:'bam'}`, so any student could
 * self-promote and then call `decrypt_bam_banking` and read all 58 BAMs'
 * transit and account numbers in plaintext.
 *
 * `app_metadata` can only be written with the service role key (Admin API or
 * direct SQL on `auth.users.raw_app_meta_data`). That is where the claim lives
 * now. There is deliberately NO fallback to `user_metadata`: a fallback would
 * restore the exact hole we are closing. If the claim is missing the answer is
 * "deny", never "assume".
 *
 * This module is dependency-free on purpose so `middleware.ts` (Edge runtime)
 * can import it. Session-fetching helpers live in `lib/admin-auth.ts`.
 */

export type AdminRole = 'program_admin' | 'super_admin'
export type KnownRole = AdminRole | 'bam'

export const ADMIN_ROLES: readonly AdminRole[] = ['program_admin', 'super_admin'] as const

/** Shape we accept: anything with the two Supabase metadata bags. */
export type ClaimBearer = {
  app_metadata?: unknown
  /** Present on the Supabase User type. Read for tamper detection ONLY. */
  user_metadata?: unknown
} | null | undefined

function bag(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * The trusted role claim. Reads `app_metadata.role` and nothing else.
 * Returns `null` when absent, malformed, or not a role we recognise, so every
 * caller's `!role` branch denies.
 */
export function getRole(user: ClaimBearer): KnownRole | null {
  const role = str(bag(user?.app_metadata).role)
  if (role === 'super_admin' || role === 'program_admin' || role === 'bam') return role
  return null
}

/**
 * The trusted BAM id claim. Reads `app_metadata.bam_id` and nothing else.
 *
 * Prefer resolving the BAM from the database (`bams.auth_user_id = user.id`)
 * where a query is already cheap: that is authoritative and needs no backfill.
 * Use this when you only have the JWT.
 */
export function getBamId(user: ClaimBearer): string | null {
  const id = str(bag(user?.app_metadata).bam_id)
  if (!id) return null
  // UUID shape guard so a junk claim can never be interpolated into a query.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null
}

export function isAdminRole(role: string | null | undefined): role is AdminRole {
  return role === 'program_admin' || role === 'super_admin'
}

export function isSuperAdmin(role: string | null | undefined): role is 'super_admin' {
  return role === 'super_admin'
}

/**
 * Tamper signal: a `role` sitting in the client-writable bag that claims more
 * than the trusted bag grants. Not used to authorize anything, only to log.
 * A hit means someone called `updateUser({ data: { role: ... } })`.
 */
export function detectRoleTampering(user: ClaimBearer): { tampered: boolean; claimed?: string } {
  const claimed = str(bag(user?.user_metadata).role)
  if (!claimed) return { tampered: false }
  const trusted = getRole(user)
  if (claimed === trusted) return { tampered: false }
  if (isAdminRole(claimed) && !isAdminRole(trusted)) return { tampered: true, claimed }
  return { tampered: false }
}

/**
 * Builds the app_metadata patch for a role assignment. Always merges so a
 * write never drops `bam_id`, and uses `null` (not `undefined`) for removal
 * because `JSON.stringify` silently drops `undefined` keys and GoTrue only
 * treats an explicit `null` as "delete this key" (P1-21).
 */
export function roleClaimPatch(
  existing: unknown,
  patch: { role?: KnownRole | null; bam_id?: string | null }
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...bag(existing) }
  if ('role' in patch) next.role = patch.role ?? null
  if ('bam_id' in patch) next.bam_id = patch.bam_id ?? null
  return next
}
