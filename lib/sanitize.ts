/**
 * String integrity primitives (ENGINEERING-RULES §7.6, "BOM class").
 *
 * Every externally-sourced string that becomes money, an address, or an
 * identifier passes through here. The 2026-08-07 incident was a single U+FEFF
 * prepended to an env var: it was invisible in every log and every UI, and it
 * silently invalidated every emailed link. `trim()` alone is not enough because
 * it removes U+FEFF but NOT U+200B/U+200C/U+200D or U+2060.
 *
 * Kept dependency-free and side-effect-free so this module is safe to import
 * from the Edge runtime (middleware) and from Deno Edge Functions.
 */

/**
 * Drops BOM, zero-width, bidi marks, word-joiner, NBSP-class separators and
 * control characters. Anything that can hide inside a value and change its
 * bytes without changing how it looks on screen.
 */
export function stripInvisible(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    const invisible =
      c === 0xfeff ||                 // BOM / zero-width no-break space
      (c >= 0x200b && c <= 0x200f) || // zero-width space/joiners + bidi marks
      (c >= 0x202a && c <= 0x202e) || // bidi embedding/override
      (c >= 0x2066 && c <= 0x2069) || // bidi isolates
      c === 0x2060 ||                 // word joiner
      c === 0x00ad ||                 // soft hyphen
      c < 0x20 ||                     // C0 controls (incl. \n \r \t)
      c === 0x7f ||                   // DEL
      (c >= 0x80 && c <= 0x9f)        // C1 controls
    if (!invisible) out += ch
  }
  return out
}

/**
 * Whitespace-class code points that collapse to a plain space (NBSP, ideographic
 * space, thin space...).
 *
 * Written as NUMERIC code points on purpose. A previous attempt used `\u00a0`
 * escapes inside a regex literal; the escapes collapsed into the literal
 * characters when the file was written, so the character class contained real
 * invisible characters and matched nothing while looking correct on screen.
 * Numbers cannot be corrupted that way. tests/sanitize.ts asserts the behaviour
 * rather than the source text.
 */
const SPACE_CODEPOINTS = new Set<number>([
  0x00a0, // no-break space
  0x1680, // ogham space mark
  0x202f, // narrow no-break space
  0x205f, // medium mathematical space
  0x3000  // ideographic space
])

function isSpaceLike(c: number): boolean {
  return SPACE_CODEPOINTS.has(c) || (c >= 0x2000 && c <= 0x200a) // en/em/thin/hair spaces
}

function normalizeSpaces(s: string): string {
  let out = ''
  for (const ch of s) {
    out += isSpaceLike(ch.codePointAt(0)!) ? ' ' : ch
  }
  return out
}

/**
 * Full cleanup for a single-line human/identifier string:
 * NFC normalize, strip invisibles, fold exotic spaces, collapse runs, trim.
 * Does NOT lowercase and does NOT remove accents.
 */
export function cleanText(s: unknown): string {
  if (typeof s !== 'string') return ''
  return normalizeSpaces(stripInvisible(s.normalize('NFC')))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Canonical email form used by EVERY read and EVERY write.
 *
 * P1-6: the read path already did `.trim().toLowerCase()` while the roster
 * PATCH path stored the raw value. A pasted "Lucas.Grabowski@uwo.ca" or a
 * trailing space therefore locked that BAM out of login, receipt upload and
 * payment with no signal anywhere. Normalizing on write is the fix; the DB
 * trigger in 0016_auth_hardening.sql is the backstop.
 *
 * Internal whitespace is removed entirely (an email can never contain a space),
 * which also kills a pasted "  a b@x.ca".
 */
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return stripInvisible(normalizeSpaces(raw.normalize('NFC')))
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * Conservative single-address shape check. Deliberately stricter than RFC 5322:
 * we would rather reject an exotic-but-legal address (Robin retypes it) than
 * accept a typo that becomes a permanent lockout or a misdirected AP email.
 */
const EMAIL_REGEX = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

export function isValidEmail(normalized: string): boolean {
  return normalized.length > 0 && normalized.length <= 254 && EMAIL_REGEX.test(normalized)
}

/**
 * Normalize + validate in one step.
 * Returns `{ ok: false }` rather than throwing so callers can decide the
 * HTTP shape. Callers MUST NOT fall back to the raw value on failure.
 */
export function parseEmail(raw: unknown): { ok: true; email: string } | { ok: false; reason: string } {
  const email = normalizeEmail(raw)
  if (!email) return { ok: false, reason: 'Email is required.' }
  if (!isValidEmail(email)) return { ok: false, reason: `"${String(raw)}" is not a valid email address.` }
  return { ok: true, email }
}

/**
 * P1-18: read an email address out of the environment.
 *
 * A BOM in MS_SENDER_MAILBOX becomes `%EF%BB%BF` once it is interpolated into a
 * Graph URL, which 404s with no visible cause. Same class as the incident that
 * triggered the audit. Returns `null` when the value is absent or unusable so
 * the caller can fail CLOSED instead of sending to a corrupt address.
 */
export function envAddress(name: string, env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[name]
  if (raw === undefined) return null
  const email = normalizeEmail(raw)
  if (!isValidEmail(email)) return null
  return email
}

/**
 * Like `envAddress` but for a comma/semicolon separated list (CC lines).
 * Invalid entries are dropped; the caller sees only usable addresses.
 */
export function envAddressList(name: string, env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[name]
  if (!raw) return []
  return raw
    .split(/[,;]/)
    .map(part => normalizeEmail(part))
    .filter(part => isValidEmail(part))
}

/**
 * Generic env string (tenant id, host, path segment). Strips invisibles and
 * trims; returns `null` when empty so callers fail closed.
 */
export function envString(name: string, env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[name]
  if (raw === undefined) return null
  const clean = cleanText(raw)
  return clean || null
}

/**
 * Safe path/folder segment. P1-27: `name.replace(/\s+/g, '-')` does NOT remove
 * U+FEFF (it is not matched by \s in every engine and survives as a real
 * character), so an invisible character produced a second, identical-looking
 * SharePoint archive folder and split the audit trail.
 */
export function slugifySegment(raw: string): string {
  return cleanText(raw)
    .replace(/[\\/:*?"<>|]/g, '-')  // characters SharePoint/Windows reject
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

// ───────────────────────────────────────────────────────────────────────────────
// Mail-header / URL-path sanitizers.
//
// These were a second, independently written copy in `lib/env-clean.ts` with a
// slightly different invisible-character set. They now sit on the single
// `stripInvisible` above. Two behaviour changes, both in the STRICTER
// direction, from collapsing them:
//
//  1. env-clean's stripper missed U+2060 (word joiner), U+00AD (soft hyphen),
//     U+2066-U+2069 (bidi isolates) and the C1 control block. Those are removed
//     now.
//  2. env-clean's stripper DELETED an interior NBSP, which turned
//     "a b@x.ca" into the perfectly valid-looking "ab@x.ca" and
//     "260 351" into an accepted PO "260351". A corrupted value must not be
//     silently repaired into a plausible one. NBSP now folds to a plain space,
//     which `addressProblem` / `tokenProblem` / `PO_NUMBER_RE` all reject, so
//     Robin retypes the value instead of AP receiving a guess.
// ───────────────────────────────────────────────────────────────────────────────

/**
 * stripInvisible + fold exotic spaces + trim. Use for anything read out of
 * `process.env`, and for addresses read out of the database (a BOM pasted into
 * a roster cell reaches a mail header just as easily as one pasted into Vercel).
 */
export function cleanEnvValue(raw: string | undefined | null): string {
  return normalizeSpaces(stripInvisible(raw ?? '')).trim()
}

/** Alias kept for readability at DB-sourced call sites. */
export function cleanAddress(raw: string | undefined | null): string {
  return cleanEnvValue(raw)
}

/**
 * Deliberately strict: a single address, no display name, no separator that
 * would let one env var smuggle in a second recipient.
 */
const SINGLE_ADDRESS_RE = /^[^\s@,;:<>"']+@[^\s@,;:<>"']+\.[A-Za-z]{2,}$/

export function isEmailAddress(v: string): boolean {
  return SINGLE_ADDRESS_RE.test(v)
}

/**
 * Fail-closed check for every address about to be handed to a mail provider or
 * spliced into a Graph URL. Returns null when fine, an error string when not.
 */
export function addressProblem(label: string, value: string): string | null {
  if (!value) return `${label} is empty after sanitizing`
  if (!isEmailAddress(value)) {
    return `${label} is not a valid single email address after sanitizing: ${JSON.stringify(value)}`
  }
  return null
}

/**
 * Read an env address, sanitized, falling back to `fallback` when unset/empty.
 * Distinct from `envAddress` above, which validates and returns null. Pair this
 * with `addressProblem` at the call site.
 */
export function envAddressOr(name: string, fallback: string): string {
  const v = cleanEnvValue(process.env[name])
  return v || cleanEnvValue(fallback)
}

/** Comma-separated env address list, sanitized, empties dropped. */
export function envAddressListOr(name: string, fallback: string): string[] {
  const raw = cleanEnvValue(process.env[name]) || cleanEnvValue(fallback)
  return raw
    .split(',')
    .map(s => cleanEnvValue(s))
    .filter(Boolean)
}

/** Opaque identifier used in a URL path (e.g. MS_TENANT_ID). */
const URL_TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/

export function envToken(name: string): string {
  return cleanEnvValue(process.env[name])
}

export function tokenProblem(label: string, value: string): string | null {
  if (!value) return `${label} is empty after sanitizing`
  if (!URL_TOKEN_RE.test(value)) {
    return `${label} contains characters that are unsafe in a URL path: ${JSON.stringify(value)}`
  }
  return null
}

/**
 * PO / job number (P1-19). AP's automation parses this off the PDF and the
 * email, so whitespace, NBSP or a stray BOM must never reach either.
 * Robin confirmed the format is 6 digits (260351).
 */
export const PO_NUMBER_RE = /^\d{6}$/

export function sanitizePoNumber(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, error: 'po_number is empty' }
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { ok: false, error: 'po_number must be a string of 6 digits' }
  }
  const value = cleanEnvValue(String(raw))
  if (!PO_NUMBER_RE.test(value)) {
    return { ok: false, error: `po_number must be exactly 6 digits (e.g. 260351), got ${JSON.stringify(value)}` }
  }
  return { ok: true, value }
}
