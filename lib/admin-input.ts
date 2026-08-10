/**
 * Shared validators for admin write routes. Pure, so every rule below is unit
 * tested without a database and cannot drift between two routes.
 *
 * Each one returns a discriminated union instead of throwing: supabase-js does
 * not throw either, and a route that wraps everything in try/catch protects
 * nothing (ENGINEERING-RULES 7.1).
 */
import { cleanText } from './sanitize'
import { lookupBank } from './banks'

/**
 * Money amount from a form field. Moved here out of /api/admin/cohorts so the
 * salary rule is testable: salary_default is NOT NULL with no default, so an
 * absent value used to fail the whole cohort create with a 400 the UI rendered
 * as a green "Saved locally".
 */
export function parseAmount(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return { ok: false, error: 'must be a number' }
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return { ok: false, error: 'must be a number' }
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'must be a positive number' }
  if (value > 100000) return { ok: false, error: 'is implausibly large, check the value' }
  return { ok: true, value: Math.round(value * 100) / 100 }
}

/**
 * Bank name for the roster. `bank_name` is the input to the institution-code
 * lookup that routes payment, so an unrecognised name must hard-fail here the
 * same way it does in onboarding-ingest rather than sit in the column looking
 * saved. The canonical `displayName` is stored so the later lookup cannot miss.
 *
 * Empty is allowed (a pending BAM has no bank yet) and normalizes to null.
 */
export function parseBankName(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'Bank must be text.' }
  const clean = cleanText(raw)
  if (!clean || isPlaceholder(clean)) return { ok: true, value: null }
  const bank = lookupBank(clean)
  if (!bank) {
    return {
      ok: false,
      error: `"${clean}" is not in the bank lookup, so its institution number is unknown. Pick a bank from the list.`
    }
  }
  return { ok: true, value: bank.displayName }
}

/**
 * Dash-class code points, as NUMBERS. The admin tables render an empty cell as a
 * dash glyph and saveEdit used to send that placeholder straight back, which
 * wrote the literal glyph into `school_id`. Written numerically for the same
 * reason as SPACE_CODEPOINTS in lib/sanitize.ts: a character class typed as
 * literal dashes cannot be reviewed by eye, and one of these is an em dash that
 * must never appear in a value we store.
 */
const DASH_CODEPOINTS = new Set<number>([
  0x2d,   // hyphen-minus
  0x2010, // hyphen
  0x2011, // non-breaking hyphen
  0x2012, // figure dash
  0x2013, // en dash
  0x2014, // em dash
  0x2015, // horizontal bar
  0x2212, // minus sign
  0xfe58, // small em dash
  0xff0d  // fullwidth hyphen-minus
])

/** True when the string is nothing but dash glyphs, i.e. an empty-cell marker. */
function isPlaceholder(s: string): boolean {
  if (!s) return false
  for (const ch of s) {
    if (!DASH_CODEPOINTS.has(ch.codePointAt(0)!)) return false
  }
  return true
}

/** Free-text school, with the display placeholder mapped back to null. */
export function parseSchoolId(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'School must be text.' }
  const clean = cleanText(raw)
  if (!clean || isPlaceholder(clean)) return { ok: true, value: null }
  if (clean.length > 120) return { ok: false, error: 'School name is too long.' }
  return { ok: true, value: clean }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(raw: unknown): raw is string {
  return typeof raw === 'string' && UUID_RE.test(raw.trim())
}

/**
 * `bams.cohort_id` is NOT NULL, so a blank selection has to be a loud 400 and
 * not a silently dropped field. A malformed uuid would otherwise surface as a
 * raw Postgres cast error.
 */
export function parseCohortId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'Pick a cohort. Every BAM belongs to one cohort.' }
  }
  const value = cleanText(raw)
  if (!isUuid(value)) {
    return { ok: false, error: 'That cohort id is not valid. Reload the page and pick the cohort again.' }
  }
  return { ok: true, value: value.toLowerCase() }
}
