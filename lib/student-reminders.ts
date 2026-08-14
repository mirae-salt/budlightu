/**
 * Telling a student they have not submitted anything yet, while they can still do something.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every automated email the program sends a student is a RESULT: your account is ready, your
 * receipt was rejected, here is your invoice. Nothing reaches them while the outcome is still
 * theirs to change. There is a spending reminder in /api/admin/warnings, but it needs a
 * warning record, and warning records are created by the audit, so it can only fire after the
 * month is over and Robin has to click it.
 *
 * On 2026-08-12 late receipts started being REFUSED. A silent deadline plus a hard refusal is
 * strictly worse for the student than the silent deadline alone was: they lose the whole
 * month's $150 and there is no longer any give. This closes that.
 *
 * WHO GETS ONE: PEOPLE AT ZERO, NOT PEOPLE UNDER $150
 * ---------------------------------------------------
 * Mirae's call, 2026-08-12, and it is the better rule. Somebody who uploaded $80 has
 * understood the process and made a decision, and emailing them is second-guessing how much
 * beer they should buy. Somebody at zero on the 14th has either forgotten or is stuck, and
 * that is the only case an email can fix. It also means the reminder can never read as a
 * complaint about the amount, because we are not counting.
 *
 * FAILS CLOSED, and gated on top of that. `mode` defaults to 'off': an unreadable switch sends
 * nothing. That is the opposite of how question notifications fail, and correct here for a
 * different reason. Three colleagues can absorb a stray email; 58 students cannot un-receive
 * one.
 *
 * NO PER-STUDENT OPT-OUT. There was one (`bams.wants_reminders`, a toggle on the account page);
 * removed 2026-08-14 per Robin, from the BL Campus x AI Final Connect meeting: "I don't want
 * them to be able to turn their reminders off." The admin `mode` switch above is still the
 * only control, which decides whether the PROGRAM sends these at all. The database column is
 * left in place rather than migrated away -- nothing reads it now, and it is cheap to bring
 * back if the answer changes again, which this exact setting already has once.
 */

export type ReminderMode =
  /** Nothing is sent and nothing is recorded. The default. */
  | 'off'
  /** Selection runs and rows are written, but no email leaves. Shows who WOULD be emailed. */
  | 'draft'
  /** Emails are sent. */
  | 'live'

export const REMINDER_MODE_KEY = 'student_reminders'

export type ReminderKind =
  /** Before the deadline, while they can still act. */
  | 'deadline'
  /** After the deadline, telling them what the month came to. */
  | 'shortfall'

/**
 * Days of the month a pre-deadline reminder goes out.
 *
 * Two, not five. The 10th leaves time to actually go and buy something; the 14th is the last
 * day that is still useful. Daily nudges from the 10th get filtered as noise, and then the one
 * that mattered is filtered too.
 *
 * Robin can change these from the admin screen, so they are a default rather than a rule.
 */
export const DEFAULT_REMINDER_DAYS = [10, 14]

export type ReminderSettings = {
  mode: ReminderMode
  /** Days of the month to send the pre-deadline reminder. */
  days: number[]
}

export const REMINDER_DEFAULT: ReminderSettings = {
  // OFF. Turning this on emails students, so it is a decision someone makes on purpose, not a
  // default that arrives with a deploy.
  mode: 'off',
  days: DEFAULT_REMINDER_DAYS
}

function isMode(v: unknown): v is ReminderMode {
  return v === 'off' || v === 'draft' || v === 'live'
}

/**
 * Reads the stored switch.
 *
 * Anything unrecognised reads as 'off'. A malformed row must not be able to start sending mail
 * to 58 students, which is exactly what defaulting to 'live' would allow.
 */
export function parseReminderSettings(raw: unknown): ReminderSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return REMINDER_DEFAULT
  const r = raw as Record<string, unknown>

  const days = Array.isArray(r.days)
    ? [...new Set(
        (r.days as unknown[])
          .map(d => Number(d))
          // 1 to 15 only. A "reminder" on the 20th is not a reminder, it is a notice about a
          // month that already closed, and that is the shortfall email's job.
          .filter(d => Number.isInteger(d) && d >= 1 && d <= 15)
      )].sort((a, b) => a - b)
    : DEFAULT_REMINDER_DAYS

  return {
    mode: isMode(r.mode) ? r.mode : 'off',
    days: days.length > 0 ? days : DEFAULT_REMINDER_DAYS
  }
}

export function validateReminderSettings(
  raw: unknown
): { ok: true; settings: ReminderSettings } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Invalid request.' }
  }
  const r = raw as Record<string, unknown>
  if (!isMode(r.mode)) {
    return { ok: false, message: 'Choose whether reminders are off, drafted, or sent.' }
  }
  if (r.days !== undefined) {
    if (!Array.isArray(r.days)) return { ok: false, message: 'Reminder days must be a list.' }
    const bad = (r.days as unknown[]).filter(d => {
      const n = Number(d)
      return !Number.isInteger(n) || n < 1 || n > 15
    })
    if (bad.length > 0) {
      return {
        ok: false,
        message: `Reminder days must be between 1 and 15, because receipts are due on the 15th. Not valid: ${bad.join(', ')}.`
      }
    }
    if ((r.days as unknown[]).length === 0) {
      return { ok: false, message: 'Pick at least one day, or set reminders to off.' }
    }
  }
  return { ok: true, settings: parseReminderSettings(r) }
}

export type ReminderCandidate = {
  bamId: string
  firstName: string
  email: string | null
  /**
   * How many receipts they have uploaded for this period.
   *
   * THIS IS THE WHOLE TEST: zero gets a reminder, anything above zero does not. See the header
   * for why this is the rule rather than a dollar threshold.
   */
  receiptCount: number
  /** Reimbursement available this period. In the email so they know what is at stake. */
  cap: number
  /** True for admin TEST rows. They still get reminders so Robin can see one. */
  isTest: boolean
  /** Statuses other than active are skipped: nobody archived should be nudged. */
  status: string
}

export type ReminderPlan =
  | { send: false; reason: string }
  | { send: true; kind: ReminderKind; daysLeft: number; cap: number }

/**
 * Whether this one person gets a pre-deadline reminder today.
 *
 * Pure, and takes the date rather than reading the clock, so the day-boundary cases are
 * testable. `alreadySent` comes from the student_reminders row: this function does not decide
 * idempotency, the database's unique index does, but it is checked here too so the common case
 * does not depend on catching a constraint violation.
 */
export function planReminder(input: {
  candidate: ReminderCandidate
  settings: ReminderSettings
  /** Day of the month, 1 to 31. */
  day: number
  alreadySent: boolean
  deadlineDay?: number
}): ReminderPlan {
  const { candidate: c, settings, day, alreadySent } = input
  const deadlineDay = input.deadlineDay ?? 15

  if (settings.mode === 'off') return { send: false, reason: 'reminders are off' }
  if (alreadySent) return { send: false, reason: 'already reminded this period' }
  if (!settings.days.includes(day)) return { send: false, reason: `not a reminder day (${day})` }

  // An email address is not optional here. There is no roster row without one in practice, but
  // a null would otherwise become a send to "null" and a confusing bounce.
  if (!c.email) return { send: false, reason: 'no email address on the roster row' }
  if (c.status !== 'active') return { send: false, reason: `status is ${c.status}` }

  // Anyone who has uploaded anything at all is left alone. One receipt means they know how
  // this works, and the amount is their decision.
  if (c.receiptCount > 0) {
    return { send: false, reason: `already submitted ${c.receiptCount} receipt(s) this month` }
  }

  return {
    send: true,
    kind: 'deadline',
    // On the 14th with a deadline of the 15th this is 1: today plus tomorrow is not "2 days
    // left" to someone deciding whether to go to a store tonight.
    daysLeft: Math.max(0, deadlineDay - day),
    cap: c.cap
  }
}

/**
 * The email itself. Kept here as a pure function so the wording is reviewable and testable
 * without a database, and so Robin can be shown exactly what a student receives.
 */
export function reminderEmail(input: {
  firstName: string
  cap: number
  daysLeft: number
  monthLabel: string
  portalUrl: string
}): { subject: string; html: string; text: string } {
  const { firstName, cap, daysLeft, monthLabel, portalUrl } = input

  // Everyone who receives this has submitted nothing, so there is no running total to report
  // and no reason to imply we have been keeping score. One fact and one link.
  const dayPhrase = daysLeft <= 0
    ? 'Today is the last day'
    : daysLeft === 1
      ? 'Tomorrow is the last day'
      : `There are ${daysLeft} days left`

  const subject = daysLeft <= 1
    ? `${dayPhrase} to submit your ${monthLabel} receipts`
    : `${daysLeft} days left to submit your ${monthLabel} receipts`

  /*
   * ONE PARAGRAPH, not three. Robin, 2026-08-14 (BL Campus x AI Final Connect): "I would
   * honestly just leave it at the first paragraph... I feel like it's a confusing system when
   * we say like claim back $150 and like it's not available the next month. If we just give
   * them exactly what we want then like hopefully there's less to interpret."
   *
   * Two paragraphs removed, not trimmed:
   *  - the $cap / no-rollover explanation, which is the "confusing" one she named directly
   *  - the closing paragraph (support link, "no reply needed", and the reminder opt-out link)
   *    -- Shane asked whether to keep it and Robin said to take it off specifically because of
   *    the opt-out link: "I don't want them to be able to turn their reminders off."
   *
   * `cap` is kept as a function PARAMETER rather than removed, even though this template no
   * longer prints it: the caller still needs to pass the right one, and deleting the parameter
   * would be the kind of change that quietly breaks the call site instead of the copy.
   */
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <p style="font-size: 15px; color: #1a1a2e; margin: 0 0 12px;">Hi ${escapeHtml(firstName)},</p>
      <p style="font-size: 14px; color: #374151; line-height: 1.6; margin: 0 0 20px;">
        ${dayPhrase} to upload your ${escapeHtml(monthLabel)} Bud Light receipts. We have not
        received any from you yet this month.
      </p>
      <p style="margin: 0 0 20px;">
        <a href="${escapeHtml(portalUrl)}/portal/upload"
           style="background: #0073cf; color: #ffffff; padding: 11px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block;">
          Upload receipts
        </a>
      </p>
      <p style="font-size: 12px; color: #9ca3af; margin-top: 20px;">Bud Light U</p>
    </div>
  `

  const text = [
    `Hi ${firstName},`,
    '',
    `${dayPhrase} to upload your ${monthLabel} Bud Light receipts. We have not received any`,
    'from you yet this month.',
    '',
    `Upload receipts: ${portalUrl}/portal/upload`,
    '',
    '- Bud Light U'
  ].join('\n')

  return { subject, html, text }
}

function escapeHtml(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
