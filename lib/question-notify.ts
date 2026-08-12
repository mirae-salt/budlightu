/**
 * How often Robin hears about support questions.
 *
 * WHY THIS IS A SETTING AND NOT A DECISION WE MAKE
 * -----------------------------------------------
 * /api/portal/support emailed on every single question, which is right at 3 questions a
 * month and wrong at 58 BAMs in onboarding week. The volume nobody can predict is
 * exactly the kind of thing the person receiving the mail should control, so this is
 * hers to set on /admin/questions rather than a number we guess and bake in.
 *
 * Stored in the existing `policy` table (key='question_notify'), like maintenance mode:
 * no new table, no redeploy, takes effect on the next question.
 *
 * FAILS LOUD, unlike maintenance mode. If the setting cannot be read we send the email
 * anyway ('each'), because the failure mode of guessing wrong here is a student's
 * question sitting unanswered. An extra email is cheap; a dropped one is not.
 */

export type QuestionNotifyMode =
  /** One email per question, as it arrives. */
  | 'each'
  /** No email on arrival. One summary a day, from the cron, listing what came in. */
  | 'daily'
  /** No email at all. The Questions page is the only place they appear. */
  | 'off'

export type QuestionNotifySetting = { mode: QuestionNotifyMode }

export const QUESTION_NOTIFY_KEY = 'question_notify'

/** What happens when nothing has been configured. See the header: loud, not quiet. */
export const QUESTION_NOTIFY_DEFAULT: QuestionNotifySetting = { mode: 'each' }

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

/**
 * Normalizes whatever is in `policy.value_json`.
 *
 * An unreadable or unrecognised value resolves to 'each' rather than 'off': a bad row
 * must not silently stop a student's question from reaching anyone.
 */
export function parseQuestionNotify(raw: unknown): QuestionNotifySetting {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return QUESTION_NOTIFY_DEFAULT
  const mode = (raw as Record<string, unknown>).mode
  if (mode === 'each' || mode === 'daily' || mode === 'off') return { mode }
  return QUESTION_NOTIFY_DEFAULT
}

/** Validates an admin's submitted value before it is written. */
export function validateQuestionNotify(
  raw: unknown
): { ok: true; value: QuestionNotifySetting } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Invalid request.' }
  }
  const mode = (raw as Record<string, unknown>).mode
  if (mode !== 'each' && mode !== 'daily' && mode !== 'off') {
    return { ok: false, message: 'Choose how often you want to be emailed.' }
  }
  return { ok: true, value: { mode } }
}

/**
 * Should the support route email as the question arrives?
 *
 * Pure, so the branch is a test rather than something to reason about inside a route
 * that is already doing four other things.
 */
export function shouldEmailOnArrival(setting: QuestionNotifySetting | null): boolean {
  // null means unreadable. Send.
  if (!setting) return true
  return setting.mode === 'each'
}

/** Should the daily cron send a digest? */
export function shouldSendDigest(setting: QuestionNotifySetting | null): boolean {
  return setting?.mode === 'daily'
}
