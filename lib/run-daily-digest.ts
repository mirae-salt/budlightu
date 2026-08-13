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
import { resolveApAddresses } from './ap-addresses'
import {
  QUESTION_NOTIFY_KEY,
  parseQuestionNotify,
  recipientsForDigest
} from './question-notify'
import { getRole, isAdminRole } from './auth-claims'
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

  // Who gets this at all, and whether it carries questions, is per admin now: the
  // setting used to be one shared value, so one person turning it down turned it down
  // for everybody.
  const { data: notifyRow, error: notifyErr } = await db
    .from('policy').select('value_json').eq('key', QUESTION_NOTIFY_KEY).limit(1)
  if (notifyErr) console.error('[daily-digest] notify setting read failed:', notifyErr.message)
  const setting = notifyErr
    ? null
    : parseQuestionNotify(((notifyRow ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)

  const { data: adminList, error: adminErr } = await db.auth.admin.listUsers({ perPage: 1000 })
  if (adminErr) console.error('[daily-digest] admin list unreadable:', adminErr.message)
  const adminEmails = (adminList?.users ?? [])
    .filter((u: { app_metadata?: unknown }) => isAdminRole(getRole(u as never)))
    .map((u: { email?: string | null }) => (u.email ?? '').trim())
    .filter(Boolean)

  const digestRecipients = recipientsForDigest(setting, adminEmails)

  let questions: DigestQuestion[] = []
  if (digestRecipients.length > 0) {
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

  // Banking reminders still need a recipient even when nobody chose the daily digest for
  // questions, so fall back to the AP CC list rather than dropping them.
  //
  // Through the resolver, so this follows the list Robin edits on Settings instead of the env
  // var she cannot see. Only reached when nobody selected the digest; if the resolver refuses
  // (unreadable setting) this keeps the env list rather than dropping the reminder, because
  // unlike an AP send the wrong recipient here is a colleague, and silence is the worse
  // failure: the pending-banking reminder is the thing stopping an invoice going to a stale
  // account.
  let fallbackTo: string[] = []
  if (digestRecipients.length === 0) {
    const resolved = await resolveApAddresses(db)
    fallbackTo = resolved.ok && resolved.cc.length > 0
      ? resolved.cc
      : envAddressListOr('AP_CC_EMAILS', 'robin.graham@ilovesalt.com')
    if (!resolved.ok) {
      console.error('[daily-digest] AP address setting unreadable, using env list:', resolved.error)
    }
  }
  const to = digestRecipients.length > 0 ? digestRecipients : fallbackTo
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
