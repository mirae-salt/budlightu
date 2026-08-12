/**
 * Which URL paths require a session.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * The rule lived as one long boolean expression inside middleware.ts, where it could
 * not be tested and could not be checked without deploying and clicking. It shipped a
 * live bug of exactly the kind that hides in a long expression: the onboarding
 * exemption was an EXACT match (`path !== '/portal/onboarding'`), so the invite link
 * itself, `/portal/onboarding/<token>`, counted as protected and 307'd to the login
 * page. A brand-new BAM has no session by definition, so every invite landed on a
 * login wall instead of the pre-filled form the invite exists to open, and the token
 * went unused. Confirmed against production with no cookies:
 *
 *   GET /portal/onboarding/<uuid>  ->  307  /portal/login
 *   GET /portal/faq                ->  200
 *   GET /portal/dashboard          ->  307  /portal/login
 *
 * That is the same shape as the sign-in gate bug: a rule that was right for the actor
 * it was written for and wrong for the one who actually arrives first. So it now lives
 * here as a pure function, middleware calls it, and tests pin every path.
 *
 * FAIL CLOSED. Anything not explicitly listed as public requires a session. Adding a
 * new public page means adding it here on purpose, which is the safe direction to
 * forget in.
 */

/**
 * Portal paths readable with no session, matched EXACTLY.
 *
 * - login: the sign-in page itself.
 * - faq / program / terms: readable before joining. `terms` matters because the
 *   onboarding form links to it, and that form is filled in before a session exists.
 */
const PUBLIC_PORTAL_EXACT: readonly string[] = [
  '/portal/login',
  '/portal/faq',
  '/portal/program',
  '/portal/terms'
]

/**
 * Portal paths readable with no session, matched by PREFIX.
 *
 * - `/portal/onboarding`: covers both the bare form and `/portal/onboarding/<token>`.
 *   Neither reads a session. The token page gates on the invite token via
 *   /api/portal/onboarding/check-token, and the token is 32 random bytes stored as a
 *   SHA-256 hash, so it is not guessable. The bare form redirects itself when there is
 *   no session, which is a page concern, not a routing one.
 * - `/portal/verify-account`: reached immediately after a first sign-in.
 */
const PUBLIC_PORTAL_PREFIX: readonly string[] = [
  '/portal/onboarding',
  '/portal/verify-account'
]

/** True when this path may be served without a session. */
export function isPublicPortalPath(path: string): boolean {
  if (PUBLIC_PORTAL_EXACT.includes(path)) return true
  return PUBLIC_PORTAL_PREFIX.some(prefix => path === prefix || path.startsWith(prefix + '/'))
}

/** A portal page that requires a signed-in BAM (or an admin visiting the portal). */
export function needsPortalAuth(path: string): boolean {
  if (!path.startsWith('/portal')) return false
  return !isPublicPortalPath(path)
}

/**
 * An admin surface. `/api/admin/*` is included deliberately: the matcher always
 * listed it, but the condition used to test only `/admin`, so `/api/admin/data`
 * (service role, returns every BAM's roster row) was not gated by the outer fence at
 * all. Every admin route also checks for itself; this is belt and braces.
 */
export function needsAdminAuth(path: string): boolean {
  return path.startsWith('/admin') || path.startsWith('/api/admin')
}
