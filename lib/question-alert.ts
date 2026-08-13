/**
 * Telling the admins that a support question is waiting.
 *
 * WHY THIS IS A SHARED FUNCTION
 * -----------------------------
 * A student can put a question in front of Robin two ways: start a thread
 * (`/api/portal/support`) or reply in one (`/api/portal/questions` POST, added with the thread
 * work on 2026-08-13). Only the first one told anybody.
 *
 * The follow-up route saved the message and reopened the thread and stopped there, on the
 * reasoning that "a follow-up on a thread Robin is already in is a different event". It is not.
 * It is a student waiting for an answer, which is the only thing this alert is about.
 *
 * AND IT WAS WORSE THAN A MISSING EMAIL. The daily digest picks up questions with
 * `notified_at is null`. The original question had already been notified, so the column was
 * stamped, and a follow-up left it stamped. So the follow-up was excluded from the immediate
 * email AND from the digest. The only trace was the sidebar count, which requires somebody to
 * already be looking at the screen the notification exists to bring them to.
 *
 * THE notified_at RULE, which is the same for both kinds and is what fixes this:
 *
 *     emailed successfully  ->  notified_at = now   (the digest must not repeat it)
 *     not emailed at all    ->  notified_at = null  (the digest MUST pick it up)
 *
 * For a new question that is exactly what the support route already did, because the column
 * starts null. For a follow-up it is the fix. One rule, so there is nothing to keep in sync.
 *
 * FAILS OPEN, deliberately, and unlike maintenance mode: if the frequency setting cannot be
 * read, the email goes out anyway. An extra email costs a colleague ten seconds; a student's
 * question sitting unanswered costs more. Same reasoning as the original route, kept.
 */
import {
  QUESTION_NOTIFY_KEY,
  parseQuestionNotify,
  recipientsForArrival
} from './question-notify'
import { getRole, isAdminRole } from './auth-claims'
import { sendEmail } from './send-email'
import { notifyAdmin } from './notify-admin'
import { envAddress } from './sanitize'
import type { serviceClient } from '../supabase/functions/_shared/supabase-admin'

type Db = ReturnType<typeof serviceClient>

/**
 * P1-18: the destination comes from env when set, sanitized (a BOM or stray whitespace in an
 * address is invisible and silently misroutes mail). Falls back to Robin's address so an unset
 * env var never means "email nobody".
 */
const ROBIN_FALLBACK = 'robin.graham@ilovesalt.com'

export function supportRecipient(): string {
  return envAddress('SUPPORT_NOTIFY_EMAIL') ?? envAddress('ROBIN_EMAIL') ?? ROBIN_FALLBACK
}

/** The template interpolates a student's own words, so it escapes them. */
function escapeHtml(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type QuestionAlertKind = 'new' | 'followup'

export interface QuestionAlertInput {
  kind: QuestionAlertKind
  /** Null only when the insert did not return one; the links degrade to the bare list. */
  questionId: string | null
  bamId: string | null
  bamName: string
  bamEmail: string
  bamSchool?: string | null
  bamCohort?: string | null
  /** The message that just arrived, which is what the admin needs to read. */
  message: string
  /** How many they had asked BEFORE this one. Only used for a new question. */
  priorQuestions?: number
  appUrl: string
}

export interface QuestionAlertResult {
  /** True when an email was sent and the provider confirmed it. */
  emailed: boolean
  emailError: string | null
  /** How many admins it went to. Zero means everybody is on daily or off, which is not an error. */
  recipients: number
  /** The in-app admin notification. */
  notified: boolean
}

export async function alertAdminsAboutQuestion(
  db: Db,
  input: QuestionAlertInput
): Promise<QuestionAlertResult> {
  const isFollowUp = input.kind === 'followup'

  // How often Robin wants these is HER setting, not ours (lib/question-notify.ts).
  // This used to email on every question, which is right at three a month and wrong
  // during onboarding week with 58 BAMs.
  const { data: notifyRow, error: notifyErr } = await db
    .from('policy').select('value_json').eq('key', QUESTION_NOTIFY_KEY).limit(1)
  if (notifyErr) {
    console.error('[question-alert] notify setting unreadable, emailing anyway:', notifyErr.message)
  }
  const notify = notifyErr
    ? null
    : parseQuestionNotify(((notifyRow ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)

  // EVERY admin who wants each question, not one hardcoded address.
  //
  // This used to mail `supportRecipient()`, a single address falling back to Robin, so
  // Robin got every question and no other admin got any -- which is why Mirae never saw
  // one. And the frequency setting was global, so one admin turning it down turned it
  // down for everybody. Both are per-admin now.
  const { data: adminList, error: adminErr } = await db.auth.admin.listUsers({ perPage: 1000 })
  if (adminErr) console.error('[question-alert] admin list unreadable:', adminErr.message)
  const adminEmails = (adminList?.users ?? [])
    .filter(u => isAdminRole(getRole(u)))
    .map(u => (u.email ?? '').trim())
    .filter(Boolean)

  // Falling back to the old single recipient rather than to nobody: if the admin list
  // cannot be read, a question still reaches a human.
  const recipients = adminEmails.length > 0
    ? recipientsForArrival(notify, adminEmails)
    : [supportRecipient()]
  const emailNow = recipients.length > 0

  const { bamName, bamSchool, bamCohort, bamEmail, appUrl, message } = input
  const text = message.trim()
  const link = input.questionId
    ? `${appUrl}/admin/questions?q=${input.questionId}`
    : `${appUrl}/admin/questions`

  const heading = isFollowUp ? 'Follow-up from a BAM' : 'New BAM question'
  const subject = isFollowUp
    ? `BLU follow-up from ${bamName}${bamSchool ? ` (${bamSchool})` : ''}`
    : `BLU support question from ${bamName}${bamSchool ? ` (${bamSchool})` : ''}`
  const standfirst = isFollowUp
    // Says the thing that is easy to get wrong: this one looked handled and is not any more.
    ? 'They replied in a thread that was marked answered, so it is open again.'
    : ((input.priorQuestions ?? 0) > 0
        ? `This is question #${(input.priorQuestions ?? 0) + 1} from this BAM.`
        : 'First question from this BAM.')

  // P1-12: the outcome is captured instead of swallowed by `.catch(() => {})`, so a silent
  // delivery failure is at least visible.
  const emailError: string | null = !emailNow ? null : await sendEmail({
    to: recipients,
    // A plain Reply should reach the student, not bounce off a send-only domain. The body
    // says it does, so it has to.
    replyTo: bamEmail || undefined,
    subject,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <p style="font-size: 16px; color: #1a1a2e; font-weight: 600; margin: 0 0 4px;">${heading}</p>
        <p style="font-size: 13px; color: #6b7280; margin: 0 0 16px;">
          ${escapeHtml(standfirst)}
        </p>

        <table style="font-size: 14px; color: #374151; line-height: 1.8; border-collapse: collapse;">
          <tr><td style="padding-right: 16px; font-weight: 600;">From</td><td>${escapeHtml(bamName)}</td></tr>
          <tr><td style="padding-right: 16px; font-weight: 600;">Email</td><td><a href="mailto:${escapeHtml(bamEmail)}">${escapeHtml(bamEmail)}</a></td></tr>
          ${bamSchool ? `<tr><td style="padding-right: 16px; font-weight: 600;">School</td><td>${escapeHtml(bamSchool)}</td></tr>` : ''}
          ${bamCohort ? `<tr><td style="padding-right: 16px; font-weight: 600;">Cohort</td><td>${escapeHtml(bamCohort)}</td></tr>` : ''}
        </table>

        <div style="margin-top: 16px; padding: 16px; background: #f3f4f6; border-radius: 8px; font-size: 14px; color: #1a1a2e; white-space: pre-wrap;">${escapeHtml(text)}</div>

        <p style="margin: 20px 0 0;">
          <a href="${escapeHtml(link)}"
             style="background: #0073cf; color: #ffffff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block;">
            ${isFollowUp ? 'Open the thread' : 'Open in the admin portal'}
          </a>
        </p>

        <p style="font-size: 13px; color: #6b7280; margin-top: 20px; line-height: 1.5;">
          Reply straight to this email and it goes to ${escapeHtml(bamName)}. Answering in the
          portal keeps it on the thread and marks it answered.
        </p>
        <p style="font-size: 12px; color: #9ca3af; margin-top: 16px;">
          You can change how often you get these on the Questions page.
        </p>
      </div>
    `,
    text: [
      heading,
      standfirst,
      '',
      `From:   ${bamName}`,
      `Email:  ${bamEmail}`,
      ...(bamSchool ? [`School: ${bamSchool}`] : []),
      ...(bamCohort ? [`Cohort: ${bamCohort}`] : []),
      '',
      text,
      '',
      `${isFollowUp ? 'Open the thread' : 'Open in the admin portal'}: ${link}`,
      `Reply to this email to answer ${bamName} directly.`,
      '',
      'You can change how often you get these on the Questions page.',
      '- Bud Light U'
    ].join('\n')
  }).then(
    // Checks `sent`. sendEmail resolves with { sent: false } on a provider failure, so a
    // rejection-only handler read that as delivered, stamped notified_at, and the digest then
    // skipped the question because it filters on notified_at is null. It reached nobody.
    // Audited 2026-08-13.
    (r) => {
      if (r.sent) return null
      const msg = r.error ?? `send failed via ${r.provider}`
      console.error('[question-alert] email to admins not sent:', msg)
      return msg
    },
    (e: unknown) => {
      // The question IS saved, so this is not data loss; it means Robin will see it on the
      // dashboard rather than in her inbox.
      console.error('[question-alert] email to admins failed:', (e as Error).message)
      return (e as Error).message
    }
  )

  const emailed = emailNow && emailError === null

  /*
   * THE HANDOVER TO THE DIGEST. See the header.
   *
   * Stamped on a successful send so the digest does not repeat it; cleared otherwise so the
   * digest is guaranteed to pick it up. Writing `null` is a no-op for a brand new question
   * (the column starts null) and is the entire fix for a follow-up, where it is still holding
   * the timestamp from the original question.
   */
  if (input.questionId) {
    const { error: stampErr } = await db
      .from('portal_questions')
      .update({ notified_at: emailed ? new Date().toISOString() : null })
      .eq('id', input.questionId)
    if (stampErr) {
      // Not fatal in the emailed case: the question is saved and Robin already has the email;
      // the cost is that tomorrow's digest may repeat it, which is the harmless direction.
      console.error('[question-alert] could not update notified_at:', stampErr.message)
    }
  }

  // Admin notification. P1-17: the result is checked, so a dropped notification is visible in
  // the logs instead of vanishing.
  const notif = await notifyAdmin({
    type: 'support_question',
    title: isFollowUp
      ? `Follow-up from ${bamName}`
      : `Support question from ${bamName}`,
    body: text.slice(0, 120),
    bam_id: input.bamId ?? undefined,
    // Carries the question id so the notification lands ON the question rather than on a list
    // of them. The page reads ?q=, switches to All so an answered one is not filtered away, and
    // highlights that card. Falls back to the bare list if there is no id.
    link: input.questionId ? `/admin/questions?q=${input.questionId}` : '/admin/questions'
  })
  if (!notif.ok) {
    console.error('[question-alert] admin notification not recorded:', notif.error)
  }

  return {
    emailed,
    emailError,
    recipients: recipients.length,
    notified: notif.ok
  }
}
