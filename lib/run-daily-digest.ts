/**
 * Sends the once-a-day "what is waiting on you" email.
 *
 * Called by /api/cron on EVERY run, not only on the 15th and 16th, because the things
 * it reports do not follow the invoice cycle: a student asks a question or files a
 * banking change whenever they like.
 *
 * Never throws. The cron's job is the money cycle; a digest failure must not take that
 * down, so every outcome comes back as data for the route to report.
 */
import { serviceClient } from '../supabase/functions/_shared/supabase-admin'
import { sendEmail } from './send-email'
import { appBaseUrl } from './app-url'
import { envAddressListOr } from './sanitize'
import {
  QUESTION_NOTIFY_KEY,
  parseQuestionNotify,
  shouldSendDigest
} from './question-notify'
import {
  hasAnythingToSend,
  digestSubject,
  digestHtml,
  digestText,
  type DigestQuestion,
  type DigestBankingRequest
} from './daily-digest'

export type DigestResult = {
  sent: boolean
  /** Why nothing went out, when nothing did. Always populated on sent: false. */
  reason?: string
  questions: number
  pendingBanking: number
  /** Rows whose notified_at could not be stamped. They will be re-sent tomorrow. */
  unstamped?: number
  error?: string
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Db = any

const name = (b: { first_name?: string | null; last_name?: string | null } | null | undefined) =>
  [b?.first_name, b?.last_name].filter(Boolean).join(' ') || 'Unnamed BAM'

export async function runDailyDigest(now: Date = new Date()): Promise<DigestResult> {
  let db: Db
  try {
    db = serviceClient()
  } catch {
    return { sent: false, reason: 'service client unavailable', questions: 0, pendingBanking: 0 }
  }

  // Banking reminders go out regardless of the question setting: that setting is about
  // question volume, and an unapproved banking change is not a question.
  const { data: bankRows, error: bankErr } = await db
    .from('banking_change_requests')
    .select('id, requested_at, reason, bams(first_name, last_name)')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
  if (bankErr) {
    console.error('[daily-digest] banking requests read failed:', bankErr.message)
  }
  const pendingBanking: DigestBankingRequest[] = (bankRows ?? []).map(
    (r: Record<string, unknown>) => ({
      id: String(r.id),
      bamName: name(Array.isArray(r.bams) ? r.bams[0] : (r.bams as never)),
      requested_at: String(r.requested_at),
      reason: String(r.reason ?? '')
    })
  )

  // Questions are only included when Robin asked for a daily summary. On 'each' the
  // support route already mailed them; on 'off' she does not want them.
  const { data: notifyRow, error: notifyErr } = await db
    .from('policy').select('value_json').eq('key', QUESTION_NOTIFY_KEY).limit(1)
  if (notifyErr) console.error('[daily-digest] notify setting read failed:', notifyErr.message)
  const setting = notifyErr
    ? null
    : parseQuestionNotify(((notifyRow ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)

  let questions: DigestQuestion[] = []
  if (shouldSendDigest(setting)) {
    // notified_at IS NULL is the marker, so this is idempotent without a cursor: a
    // second run today finds nothing, and a failed send leaves rows for tomorrow.
    const { data: qRows, error: qErr } = await db
      .from('portal_questions')
      .select('id, question, submitted_at, bams(first_name, last_name, email)')
      .is('notified_at', null)
      .order('submitted_at', { ascending: true })
    if (qErr) {
      console.error('[daily-digest] questions read failed:', qErr.message)
    } else {
      questions = (qRows ?? []).map((r: Record<string, unknown>) => {
        const b = (Array.isArray(r.bams) ? r.bams[0] : r.bams) as
          { first_name?: string | null; last_name?: string | null; email?: string | null } | null
        return {
          id: String(r.id),
          question: String(r.question ?? ''),
          submitted_at: String(r.submitted_at),
          bamName: name(b),
          bamEmail: b?.email ?? null
        }
      })
    }
  }

  const input = { questions, pendingBanking, appUrl: appBaseUrl() }
  if (!hasAnythingToSend(input)) {
    // An empty daily email trains people to stop opening it.
    return { sent: false, reason: 'nothing waiting', questions: 0, pendingBanking: 0 }
  }

  const to = envAddressListOr('AP_CC_EMAILS', 'robin.graham@ilovesalt.com')
  const result = await sendEmail({
    to,
    subject: digestSubject(input),
    html: digestHtml(input, now),
    text: digestText(input, now)
  })

  if (!result.sent) {
    // Nothing is stamped, so tomorrow's run tries again with the same questions.
    return {
      sent: false,
      reason: 'email failed',
      error: result.error,
      questions: questions.length,
      pendingBanking: pendingBanking.length
    }
  }

  // Stamp only AFTER a successful send. Stamping first would lose a question forever if
  // the send failed. Banking requests are not stamped: they repeat until decided.
  let unstamped = 0
  if (questions.length > 0) {
    const { data: stamped, error: stampErr } = await db
      .from('portal_questions')
      .update({ notified_at: now.toISOString() })
      .in('id', questions.map(q => q.id))
      .select('id')
    if (stampErr || (stamped ?? []).length !== questions.length) {
      unstamped = questions.length - (stamped ?? []).length
      console.error(
        '[daily-digest] sent but could not stamp every question:',
        stampErr?.message ?? `${unstamped} rows unstamped`,
        '- they will appear in tomorrow\'s digest too'
      )
    }
  }

  return {
    sent: true,
    questions: questions.length,
    pendingBanking: pendingBanking.length,
    ...(unstamped > 0 ? { unstamped } : {})
  }
}
