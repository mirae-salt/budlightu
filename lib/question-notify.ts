/**
 * How often EACH admin hears about support questions.
 *
 * PER ADMIN, NOT GLOBAL. This started as one setting for everyone, which meant Mirae
 * choosing "once a day" silently changed Robin's and Nathan's too -- one person quietly
 * turning off another person's alerts about a student waiting for an answer. Caught on
 * 2026-08-12 while it was live.
 *
 * Stored as one row in the existing `policy` table (key='question_notify'):
 *
 *   { "default": "each", "byEmail": { "robin.graham@ilovesalt.com": "daily" } }
 *
 * One row, no schema change, and an admin who has never touched it falls back to the
 * default rather than to nothing.
 *
 * FAILS LOUD, unlike maintenance mode. If the setting cannot be read we send anyway: an
 * extra email is cheap, a student's question sitting unanswered is not. A malformed value
 * resolves to 'each' for the same reason.
 */

export type QuestionNotifyMode =
  /** One email per question, as it arrives. */
  | 'each'
  /** No email on arrival. One summary a day from the cron, listing what came in. */
  | 'daily'
  /** No email at all. The Questions page is the only place they appear. */
  | 'off'

export type QuestionNotifySettings = {
  /** Applies to any admin with no entry of their own. */
  default: QuestionNotifyMode
  /** Keyed by lowercased email. */
  byEmail: Record<string, QuestionNotifyMode>
}

export const QUESTION_NOTIFY_KEY = 'question_notify'

export const QUESTION_NOTIFY_DEFAULT: QuestionNotifySettings = { default: 'each', byEmail: {} }

export const QUESTION_NOTIFY_OPTIONS: Array<{
  mode: QuestionNotifyMode
  label: string
  detail: string
}> = [
  {
    mode: 'each',
    label: 'Every question, right away',
    detail: 'One email per question. Best while volumes are low.'
  },
  {
    mode: 'daily',
    label: 'Once a day',
    detail: 'One summary each morning listing everything that came in. Nothing is lost, it just waits.'
  },
  {
    mode: 'off',
    label: 'No emails',
    detail: 'Questions only appear on this page. Nothing will prompt you to look.'
  }
]

function isMode(v: unknown): v is QuestionNotifyMode {
  return v === 'each' || v === 'daily' || v === 'off'
}

export function normalizeAdminEmail(email: string | null | undefined): string {
  return String(email ?? '').trim().toLowerCase()
}

/**
 * Normalizes whatever is in `policy.value_json`.
 *
 * Accepts the OLD single-setting shape `{ mode: 'daily' }` and reads it as the default,
 * so the row written before this was per-admin keeps behaving the same way for everyone
 * rather than silently resetting to 'each'.
 *
 * Anything unrecognised resolves to 'each', never 'off': a malformed row must not quietly
 * stop questions from reaching anyone.
 */
export function parseQuestionNotify(raw: unknown): QuestionNotifySettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return QUESTION_NOTIFY_DEFAULT
  const r = raw as Record<string, unknown>

  // Old shape, from before this was per-admin.
  if (isMode(r.mode) && r.default === undefined && r.byEmail === undefined) {
    return { default: r.mode, byEmail: {} }
  }

  const byEmail: Record<string, QuestionNotifyMode> = {}
  const rawBy = r.byEmail
  if (rawBy && typeof rawBy === 'object' && !Array.isArray(rawBy)) {
    for (const [email, mode] of Object.entries(rawBy as Record<string, unknown>)) {
      const key = normalizeAdminEmail(email)
      if (key && isMode(mode)) byEmail[key] = mode
    }
  }

  return {
    default: isMode(r.default) ? r.default : 'each',
    byEmail
  }
}

/** The mode that applies to one admin. */
export function modeFor(
  settings: QuestionNotifySettings | null,
  email: string | null | undefined
): QuestionNotifyMode {
  if (!settings) return 'each'
  const key = normalizeAdminEmail(email)
  return settings.byEmail[key] ?? settings.default
}

/** Whether this admin has set their own, as opposed to inheriting the default. */
export function hasOwnSetting(
  settings: QuestionNotifySettings | null,
  email: string | null | undefined
): boolean {
  if (!settings) return false
  return normalizeAdminEmail(email) in settings.byEmail
}

/**
 * Applies one admin's choice, leaving everybody else's untouched.
 *
 * Pure and returning a new object on purpose: the route reads, applies this, and writes
 * back, so a change can never widen past the person who made it.
 */
export function withModeFor(
  settings: QuestionNotifySettings | null,
  email: string | null | undefined,
  mode: QuestionNotifyMode
): QuestionNotifySettings {
  const base = settings ?? QUESTION_NOTIFY_DEFAULT
  const key = normalizeAdminEmail(email)
  if (!key) return base
  return { default: base.default, byEmail: { ...base.byEmail, [key]: mode } }
}

/** Validates an admin's submitted value. */
export function validateQuestionNotify(
  raw: unknown
): { ok: true; mode: QuestionNotifyMode } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Invalid request.' }
  }
  const mode = (raw as Record<string, unknown>).mode
  if (!isMode(mode)) return { ok: false, message: 'Choose how often you want to be emailed.' }
  return { ok: true, mode }
}

/** Admins to email as each question arrives. */
export function recipientsForArrival(
  settings: QuestionNotifySettings | null,
  adminEmails: string[]
): string[] {
  // No readable settings: tell everyone. See the header.
  if (!settings) return adminEmails
  return adminEmails.filter(e => modeFor(settings, e) === 'each')
}

/** Admins to include in the daily digest. */
export function recipientsForDigest(
  settings: QuestionNotifySettings | null,
  adminEmails: string[]
): string[] {
  if (!settings) return []
  return adminEmails.filter(e => modeFor(settings, e) === 'daily')
}
