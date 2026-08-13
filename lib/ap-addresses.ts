/**
 * Who the invoice email goes to.
 *
 * WHY THIS EXISTS
 * ---------------
 * The AP recipient and CC list lived in environment variables, so changing them meant a Vercel
 * edit and a redeploy: Robin could not do it, and "ask Mirae" stops working the day Mirae
 * leaves. Mirae, 2026-08-13: *"직접 수정하면 코드가 깨지는겨? 걍 지가 하라고 하면 되잖아 어차피
 * 관리자라 모든 책임 다 질텐데."* Nothing breaks. The risk is a typo sending someone's pay to the
 * wrong inbox, and Robin is the person who owns that risk.
 *
 * POLICY FIRST, ENV AS FALLBACK
 * -----------------------------
 * The Edge Function deploys separately and can run before the policy row exists, so the env
 * read is load-bearing rather than laziness. The fallback covers "never configured". It does
 * NOT cover "configured but unreadable" -- see the failure direction below.
 *
 * HOW THIS FAILS, AND WHY THAT WAY
 * --------------------------------
 *   row absent          -> env. That is today's behaviour and today's correct address.
 *   row present, valid  -> the row. Robin's edit wins.
 *   row present, broken -> REFUSE. A stored value that cannot be parsed must not fall back to
 *                          env, because then a bad edit looks like it worked and the money
 *                          quietly keeps going to the old place.
 *   read error          -> REFUSE. We do not know where this should go. A blocked send is
 *                          recoverable in an afternoon; an invoice mailed to the wrong inbox
 *                          is discovered when somebody is not paid.
 *
 * This is fail CLOSED, unlike maintenance mode, and for the reason stated in CLAUDE.md: the
 * cost of the two failures is not symmetric.
 *
 * NOT COVERED HERE, on purpose: lib/send-email.ts uses AP_CC_EMAILS[0] as a Reply-To fallback.
 * That is not a recipient of anything, and putting a database read inside the mailer would put
 * a query in the path of every email, including the ones that report database problems.
 */
import { addressProblem, cleanAddress, envAddressOr, envAddressListOr } from './sanitize'
import type { serviceClient } from '../supabase/functions/_shared/supabase-admin'

/** Row key in the existing `policy` table. Same pattern as question_notify and maintenance. */
export const AP_EMAIL_KEY = 'ap_email'

/** Identical to the literals the two senders used before this file existed. */
export const AP_TO_FALLBACK = 'accounts.payable@ilovesalt.com'
export const AP_CC_FALLBACK = 'robin.graham@ilovesalt.com,nb@ilovesalt.com'

export type ApAddresses = {
  to: string
  cc: string[]
  /** Where the values came from, so the UI and the probe can say. */
  source: 'policy' | 'env'
}

export type ApAddressResult =
  | ({ ok: true } & ApAddresses)
  | { ok: false; error: string }

/**
 * Validate a to/cc pair. Returns every problem, not just the first, so an admin fixing two
 * typos is told about both instead of discovering the second after saving.
 *
 * Pure. This is the function the write path and the read path share, so a value that gets
 * stored is a value that will resolve.
 */
export function apAddressProblems(a: { to: string; cc: string[] }): string[] {
  const problems: string[] = []
  const to = addressProblem('AP recipient', a.to)
  if (to) problems.push(to)
  a.cc.forEach((addr, i) => {
    const p = addressProblem(`CC ${i + 1}`, addr)
    if (p) problems.push(p)
  })
  // A duplicate is not dangerous, but it puts somebody's name on the email twice and looks
  // like a mistake to AP, who are the audience for this particular piece of tidiness.
  const seen = new Set<string>()
  for (const addr of [a.to, ...a.cc]) {
    const k = addr.toLowerCase()
    if (seen.has(k)) problems.push(`${addr} appears more than once`)
    seen.add(k)
  }
  return problems
}

/**
 * Sanitize a submitted or stored pair into the canonical shape. Empty CC entries are dropped
 * (a trailing comma is not an error); everything else is left for apAddressProblems to judge,
 * so a corrupt value is REPORTED rather than repaired into a plausible one.
 */
export function normalizeApAddresses(raw: { to?: unknown; cc?: unknown }): { to: string; cc: string[] } {
  const to = cleanAddress(typeof raw.to === 'string' ? raw.to : '')
  const ccInput = Array.isArray(raw.cc)
    ? raw.cc
    : typeof raw.cc === 'string'
      ? raw.cc.split(',')
      : []
  const cc = ccInput
    .map(v => cleanAddress(typeof v === 'string' ? v : ''))
    .filter(Boolean)
  return { to, cc }
}

/** What the senders used before any of this: the environment, with the code-level defaults. */
export function envApAddresses(): ApAddresses {
  return {
    to: envAddressOr('AP_EMAIL', AP_TO_FALLBACK),
    cc: envAddressListOr('AP_CC_EMAILS', AP_CC_FALLBACK),
    source: 'env'
  }
}

/**
 * Turn a stored `policy.value_json` into addresses.
 *
 * Returns null for "no usable value here", which the caller treats as REFUSE, not as
 * "fall back". Absence of the row is a separate case and is handled in resolveApAddresses.
 */
export function parseApAddresses(value: unknown): { to: string; cc: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { to, cc } = normalizeApAddresses(value as { to?: unknown; cc?: unknown })
  if (!to) return null
  return { to, cc }
}

/** Where an invoice email would go RIGHT NOW. The one function every sender and the probe use. */
export async function resolveApAddresses(
  db: ReturnType<typeof serviceClient>
): Promise<ApAddressResult> {
  const { data, error } = await db
    .from('policy')
    .select('value_json')
    .eq('key', AP_EMAIL_KEY)
    .limit(1)

  if (error) {
    console.error('[ap-addresses] policy read failed, refusing to guess:', error.message)
    return {
      ok: false,
      error:
        `Could not read the AP address setting (${error.message}). ` +
        'Refusing to send rather than guess the recipient.'
    }
  }

  const row = (data ?? [])[0] as { value_json?: unknown } | undefined

  if (!row) {
    // Never configured. The environment is the truth, and it is the same value that was in use
    // before this setting existed.
    const env = envApAddresses()
    const problems = apAddressProblems(env)
    if (problems.length > 0) {
      return { ok: false, error: `AP addresses from the environment are unusable: ${problems.join('; ')}` }
    }
    return { ok: true, ...env }
  }

  const parsed = parseApAddresses(row.value_json)
  if (!parsed) {
    return {
      ok: false,
      error:
        'The stored AP address setting is not usable. Fix it on the Settings page. ' +
        'It is deliberately NOT falling back to the environment: that would send to the old ' +
        'address while the screen showed the new one.'
    }
  }

  const problems = apAddressProblems(parsed)
  if (problems.length > 0) {
    return { ok: false, error: `Stored AP addresses are unusable: ${problems.join('; ')}` }
  }

  return { ok: true, to: parsed.to, cc: parsed.cc, source: 'policy' }
}
