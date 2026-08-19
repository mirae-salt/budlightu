/**
 * Maintenance mode: a switch that shows students "we are working on this, come back
 * shortly" instead of a half-working portal during a deploy or a data fix.
 *
 * THE ONE THING THIS MUST NEVER DO IS LOCK THE OPERATOR OUT
 * --------------------------------------------------------
 * A maintenance switch that also blocks the person holding it is unfixable from the
 * app. This week already produced two versions of that bug -- administrators locked
 * out of the whole product by the sign-in gate, and every new BAM bounced off the
 * invite link -- so the rule is written here as a pure function with tests rather than
 * scattered through a layout.
 *
 * Three guarantees, in order of importance:
 *   1. /portal/login is NEVER blocked. It is the way back in. An admin who is not
 *      signed in yet has no role to bypass with, so blocking the login page would
 *      leave nobody able to turn the switch off.
 *   2. Admins are never blocked, anywhere.
 *   3. /admin is never blocked. That is where the off switch lives.
 *
 * FAIL OPEN, deliberately. This is the opposite of the auth gates in this codebase.
 * If the flag cannot be read, students get the normal portal. A read failure taking
 * the portal down would turn a transient database hiccup into an outage, and the worst
 * case of failing open is that someone sees a working app during maintenance.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */

/**
 * How loud the notice is.
 *
 * `banner`: a strip above the page. Everything keeps working. This is the one that
 * gets used often -- "we are deploying at 8pm", "receipts may be slow for an hour" --
 * especially around the 15th when BAMs are submitting.
 * `block`: replaces the page. For the rare case where letting someone submit into a
 * half-working app is worse than turning them away.
 *
 * Defaults to `banner` when unspecified, because the quieter of the two is the safer
 * thing to end up with by accident.
 */
export type MaintenanceMode = 'banner' | 'block'

export type MaintenanceState = {
  /** Whether the notice is showing. */
  on: boolean
  mode: MaintenanceMode
  /** Shown to students. Falls back to DEFAULT_MESSAGE when blank. */
  message: string
  /**
   * Optional ISO timestamp for "back by". Purely informational: passing it does NOT
   * switch maintenance off on its own, because a forgotten timer that silently lifts
   * a notice mid-deploy is worse than one that has to be turned off by hand.
   */
  until: string | null
}

export const MAINTENANCE_KEY = 'maintenance'

/** Used when a block is turned on with no message. */
export const DEFAULT_MESSAGE =
  'The portal is briefly down for maintenance. Please try again in a few minutes.'

/** Used when a banner is turned on with no message. */
export const DEFAULT_BANNER_MESSAGE =
  'Scheduled maintenance this evening. The portal may be briefly unavailable.'

export const MAINTENANCE_OFF: MaintenanceState = { on: false, mode: 'banner', message: '', until: null }

/** Paths that stay reachable even with maintenance on. See guarantee 1 and 3. */
function isAlwaysReachable(path: string): boolean {
  if (path === '/portal/login') return true
  if (path === '/admin' || path.startsWith('/admin/')) return true
  return false
}

/**
 * Should this visitor see the maintenance screen instead of the page?
 *
 * Pure, so every case below is a test rather than something to reason about while
 * staring at a layout file.
 */
export function shouldShowMaintenance(input: {
  state: MaintenanceState | null
  path: string
  /** True when the signed-in user holds an admin role claim. */
  isAdmin: boolean
}): boolean {
  // Fail open: no readable state means no notice.
  if (!input.state || !input.state.on) return false
  // A banner never takes the page away. Only 'block' does.
  if (input.state.mode !== 'block') return false
  if (input.isAdmin) return false
  if (isAlwaysReachable(input.path)) return false
  return input.path.startsWith('/portal')
}

/**
 * Should this visitor see the banner strip?
 *
 * Shown on portal pages including the sign-in page, because "we are down at 8pm" is
 * worth knowing before you sign in. Admins DO see it: it is information, not an
 * obstacle, and an admin should be able to tell at a glance that the notice is live
 * without opening a private window.
 */
export function shouldShowBanner(input: {
  state: MaintenanceState | null
  path: string
}): boolean {
  if (!input.state || !input.state.on) return false
  if (input.state.mode !== 'banner') return false
  return input.path.startsWith('/portal') || input.path.startsWith('/admin')
}

/**
 * Normalizes whatever is in `policy.value_json` into a usable state.
 *
 * Anything unparseable resolves to OFF rather than ON. A malformed row must not put
 * the portal into maintenance that nobody asked for.
 */
export function parseMaintenance(raw: unknown): MaintenanceState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return MAINTENANCE_OFF
  const r = raw as Record<string, unknown>

  // Only a real boolean true turns it on. A stray "false" string or a 0 does not.
  const on = r.on === true
  if (!on) return MAINTENANCE_OFF

  // Anything other than the literal 'block' is a banner. Ending up with the quieter
  // notice from a malformed value is the safe direction.
  const mode: MaintenanceMode = r.mode === 'block' ? 'block' : 'banner'

  const message = typeof r.message === 'string' && r.message.trim()
    ? r.message.trim()
    : (mode === 'block' ? DEFAULT_MESSAGE : DEFAULT_BANNER_MESSAGE)

  let until: string | null = null
  if (typeof r.until === 'string' && r.until.trim()) {
    const t = Date.parse(r.until)
    // An unparseable timestamp is dropped rather than shown as "Invalid Date".
    if (!Number.isNaN(t)) until = new Date(t).toISOString()
  }

  return { on: true, mode, message, until }
}

/** The 1000-char ceiling matches the other admin free-text fields (lib/reason.ts). */
export const MAX_MESSAGE_LENGTH = 1000

/** Validates an admin's submitted state before it is written. */
export function validateMaintenanceInput(
  raw: unknown
): { ok: true; value: MaintenanceState } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Invalid request.' }
  }
  const r = raw as Record<string, unknown>

  if (typeof r.on !== 'boolean') {
    return { ok: false, message: 'Say explicitly whether maintenance is on or off.' }
  }
  if (!r.on) return { ok: true, value: MAINTENANCE_OFF }

  if (r.mode !== 'banner' && r.mode !== 'block') {
    return { ok: false, message: 'Choose whether this is a banner or a full block.' }
  }
  const mode: MaintenanceMode = r.mode

  const rawMessage = typeof r.message === 'string' ? r.message.trim() : ''
  if (rawMessage.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, message: `That message is too long (max ${MAX_MESSAGE_LENGTH} characters).` }
  }

  let until: string | null = null
  if (typeof r.until === 'string' && r.until.trim()) {
    const t = Date.parse(r.until)
    if (Number.isNaN(t)) {
      return { ok: false, message: 'That "back by" time could not be read. Leave it blank or pick a time.' }
    }
    until = new Date(t).toISOString()
  }

  const fallback = mode === 'block' ? DEFAULT_MESSAGE : DEFAULT_BANNER_MESSAGE
  return { ok: true, value: { on: true, mode, message: rawMessage || fallback, until } }
}
