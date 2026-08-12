/**
 * Telling a student they are about to lose their $150, while they can still do something.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every automated email the program sends a student is a RESULT: your account is ready, your
 * receipt was rejected, here is your invoice. Nothing reaches them while the outcome is still
 * theirs to change. There is a spending reminder in /api/admin/warnings, but it needs a
 * warning record, and warning records are created by the audit on the 15th, so it can only
 * fire after the month is over and Robin has to click it.
 *
 * On 2026-08-12 late receipts started being REFUSED. A silent deadline plus a hard refusal
 * is strictly worse for the student than the silent deadline alone was: they lose the whole
 * month's $150 and there is no longer any give. This closes that.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No judgement about whether someone is trying. This sends on one fact -- how much of the
 * cap is unspent with N days to go -- and says only that. Reading intent into a number is
 * Robin's job, and she has the dashboard and the shortfall warning for it.
 *
 * FAILS CLOSED, and gated on top of that. `mode` defaults to 'off': an unreadable switch
 * sends nothing. That is the opposite of how question notifications fail, and correct here
 * for a different reason -- the audience is 58 students rather than three colleagues, and an
 * unwanted email to a student cannot be walked back with a Slack message.
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
 * day that is still useful. Daily nudges from the 10th get filtered as noise, and then the
 * one that mattered is filtered too.
 *
 * Robin can change these from the admin screen, so they are a default rather than a rule.
 */
export const DEFAULT_REMINDER_DAYS = [10, 14]

export type ReminderSettings = {
  mode: ReminderMode
  /** Days of the month to send the pre-deadline reminder. */
  days: number[]
  /**
   * Send the pre-deadline reminder only when they are below this. Null means send to
   * everyone who has not hit the cap.
   */
  belowCad: number | null
}

export const REMINDER_DEFAULT: ReminderSettings = {
  // OFF. Turning this on emails students, so it is a decision someone makes on purpose,
  // not a default that arrives with a deploy.
  mode: 'off',
  days: DEFAULT_REMINDER_DAYS,
  belowCad: null
}

function isMode(v: unknown): v is ReminderMode {
  return v === 'off' || v === 'draft' || v === 'live'
}

/**
 * Reads the stored switch.
 *
 * Anything unrecognised reads as 'off'. A malformed row must not be able to start sending
 * mail to 58 students, which is exactly what defaulting to 'live' would allow.
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

  const below = Number(r.belowCad)

  return {
    mode: isMode(r.mode) ? r.mode : 'off',
    days: days.length > 0 ? days : DEFAULT_REMINDER_DAYS,
    belowCad: Number.isFinite(below) && below > 0 ? below : null
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
  /** Bud Light spend counted so far this period, tax included. */
  spent: number
  cap: number
  /** True for admin TEST rows. They still get reminders so Robin can see one. */
  isTest: boolean
  /** Statuses other than active are skipped: nobody archived should be nudged. */
  status: string
}

export type ReminderPlan =
  | { send: false; reason: string }
  | { send: true; kind: ReminderKind; daysLeft: number; remaining: number }

/**
 * Whether this one person gets a pre-deadline reminder today.
 *
 * Pure, and takes the date rather than reading the clock, so the day-boundary cases are
 * testable. `alreadySent` comes from the student_reminders row: this function does not decide
 * idempotency, the database's unique index does, but it is checked here too so the common
 * case does not depend on catching a constraint violation.
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

  // An email address is not optional here. There is no roster row without one in practice,
  // but a null would otherwise become a send to "null" and a confusing bounce.
  if (!c.email) return { send: false, reason: 'no email address on the roster row' }
  if (c.status !== 'active') return { send: false, reason: `status is ${c.status}` }

  const remaining = Math.max(0, round2(c.cap - c.spent))
  // Nothing to remind them about. Reaching the cap is the outcome the program wants; an
  // email saying "you are done" is the kind of message that makes the next one ignorable.
  if (remaining <= 0) return { send: false, reason: 'cap already reached' }

  if (settings.belowCad !== null && c.spent >= settings.belowCad) {
    return { send: false, reason: `spent $${c.spent.toFixed(2)}, at or above the $${settings.belowCad} threshold` }
  }

  return {
    send: true,
    kind: 'deadline',
    // On the 14th with a deadline of the 15th this is 1: today plus tomorrow is not "2 days
    // left" to someone deciding whether to go to a store tonight.
    daysLeft: Math.max(0, deadlineDay - day),
    remaining
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * The email itself. Kept here as a pure function so the wording is reviewable and testable
 * without a database, and so Robin can be shown exactly what a student receives.
 */
export function reminderEmail(input: {
  firstName: string
  spent: number
  cap: number
  daysLeft: number
  monthLabel: string
  portalUrl: string
}): { subject: string; html: string; text: string } {
  const { firstName, spent, cap, daysLeft, monthLabel, portalUrl } = input
  const remaining = Math.max(0, round2(cap - spent))
  const dayPhrase = daysLeft <= 0
    ? 'Today is the last day'
    : daysLeft === 1
      ? 'Tomorrow is the last day'
      : `You have ${daysLeft} days`

  // No guilt, no "don't forget!!", no exclamation marks. One fact and one link. This is a
  // reminder about money the student is entitled to, not a chase.
  const subject = `${dayPhrase.startsWith('You') ? `${daysLeft} days left` : dayPhrase} to submit ${monthLabel} receipts`

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <p style="font-size: 15px; color: #1a1a2e; margin: 0 0 12px;">Hi ${escapeHtml(firstName)},</p>
      <p style="font-size: 14px; color: #374151; line-height: 1.6; margin: 0 0 16px;">
        ${dayPhrase.toLowerCase() === 'today is the last day' ? 'Today is the last day' : dayPhrase}
        to upload your ${escapeHtml(monthLabel)} Bud Light receipts.
      </p>
      <table style="font-size: 14px; color: #374151; line-height: 1.9; border-collapse: collapse; margin: 0 0 16px;">
        <tr><td style="padding-right: 16px; font-weight: 600;">Submitted so far</td><td>$${spent.toFixed(2)}</td></tr>
        <tr><td style="padding-right: 16px; font-weight: 600;">Still available</td><td>$${remaining.toFixed(2)} of $${cap.toFixed(2)}</td></tr>
      </table>
      <p style="font-size: 14px; color: #374151; line-height: 1.6; margin: 0 0 20px;">
        Whatever is left over does not carry into next month, so this month's amount is only
        available until the 15th.
      </p>
      <p style="margin: 0 0 20px;">
        <a href="${escapeHtml(portalUrl)}/portal/upload"
           style="background: #0073cf; color: #ffffff; padding: 11px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block;">
          Upload receipts
        </a>
      </p>
      <p style="font-size: 13px; color: #6b7280; line-height: 1.6; margin: 0;">
        Nothing to submit this month? That is fine, no reply needed. If something is in the
        way, tell us on the
        <a href="${escapeHtml(portalUrl)}/portal/support" style="color: #0073cf;">Support page</a>
        and we will sort it out.
      </p>
      <p style="font-size: 12px; color: #9ca3af; margin-top: 20px;">Bud Light U</p>
    </div>
  `

  const text = [
    `Hi ${firstName},`,
    '',
    `${dayPhrase} to upload your ${monthLabel} Bud Light receipts.`,
    '',
    `Submitted so far:  $${spent.toFixed(2)}`,
    `Still available:   $${remaining.toFixed(2)} of $${cap.toFixed(2)}`,
    '',
    "Whatever is left over does not carry into next month, so this month's amount is only",
    'available until the 15th.',
    '',
    `Upload receipts: ${portalUrl}/portal/upload`,
    '',
    'Nothing to submit this month? That is fine, no reply needed. If something is in the way,',
    `tell us on the Support page: ${portalUrl}/portal/support`,
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
