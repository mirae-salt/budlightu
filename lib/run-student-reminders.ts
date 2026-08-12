/**
 * The daily pass that emails students who still have reimbursement left to claim.
 *
 * Runs from /api/cron, which fires every day. Selection and wording are in
 * lib/student-reminders.ts as pure functions; this file is the database and the send.
 *
 * ORDER MATTERS: the student_reminders row is INSERTED BEFORE the email is sent, and the
 * unique index on (bam_id, period, kind) is what stops a repeat. Sending first and recording
 * after means two overlapping cron invocations both send. Recording first means the worst case
 * is a reminder that is claimed and never delivered, which is visible in send_error, rather
 * than a student getting the same email twice.
 *
 * OFF BY DEFAULT, and it fails closed: an unreadable switch sends nothing. The audience is 58
 * students, and an unwanted email to a student cannot be walked back.
 */
import { serviceClient } from '../supabase/functions/_shared/supabase-admin'
import { sendEmail } from './send-email'
import { appBaseUrl } from './app-url'
import {
  REMINDER_MODE_KEY,
  parseReminderSettings,
  planReminder,
  reminderEmail,
  type ReminderCandidate,
  type ReminderSettings
} from './student-reminders'

export type ReminderRunResult = {
  ran: boolean
  mode: ReminderSettings['mode']
  /** Why nothing happened, when nothing happened. */
  note?: string
  considered: number
  selected: number
  sent: number
  failed: number
  /** Present when the switch could not be read. Nothing is sent in that case. */
  degraded?: boolean
  errors: string[]
}

function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number)
  if (!y || !m) return period
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC'
  })
}

export async function runStudentReminders(now: Date = new Date()): Promise<ReminderRunResult> {
  const empty = { considered: 0, selected: 0, sent: 0, failed: 0, errors: [] as string[] }

  let db
  try {
    db = serviceClient()
  } catch {
    return { ran: false, mode: 'off', note: 'service client unavailable', degraded: true, ...empty }
  }

  const { data: polRow, error: polErr } = await db
    .from('policy').select('value_json').eq('key', REMINDER_MODE_KEY).limit(1)
  if (polErr) {
    // Fails CLOSED. See the header: this is the opposite of question notifications, because
    // the cost of an extra email is not symmetric between colleagues and students.
    console.error('[student-reminders] switch unreadable, sending nothing:', polErr.message)
    return {
      ran: false, mode: 'off', degraded: true,
      note: `could not read the reminder switch, so nothing was sent: ${polErr.message}`,
      ...empty
    }
  }

  const settings = parseReminderSettings(((polRow ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)
  if (settings.mode === 'off') {
    return { ran: false, mode: 'off', note: 'reminders are off', ...empty }
  }

  const day = now.getUTCDate()
  if (!settings.days.includes(day)) {
    return {
      ran: false, mode: settings.mode,
      note: `day ${day} is not a reminder day (${settings.days.join(', ')})`,
      ...empty
    }
  }

  // The period a receipt uploaded today belongs to: this calendar month, since reminders only
  // run on days 1 to 15 and the deadline is the 15th.
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`

  const { data: bamRows, error: bamErr } = await db
    .from('bams')
    .select('id, first_name, email, status, is_test, cohort_id, wants_reminders')
    .eq('status', 'active')
  if (bamErr) {
    console.error('[student-reminders] roster read failed:', bamErr.message)
    return { ran: false, mode: settings.mode, note: `roster unreadable: ${bamErr.message}`, ...empty }
  }
  const bams = (bamRows ?? []) as Array<{
    id: string; first_name: string; email: string | null
    status: string; is_test: boolean | null; cohort_id: string | null
    wants_reminders: boolean | null
  }>

  // WHO HAS UPLOADED ANYTHING, not how much they spent. The rule is "submitted nothing"
  // (lib/student-reminders.ts), so one receipt of any value takes somebody off this list.
  //
  // Every status counts, including rejected and ocr_failed. Someone whose receipt failed OCR
  // has done their part, and telling them "we have not received any from you" would be false.
  const { data: receiptRows, error: recErr } = await db
    .from('receipts')
    .select('bam_id')
    .eq('period', period)
  if (recErr) {
    console.error('[student-reminders] receipts read failed:', recErr.message)
    return {
      ran: false, mode: settings.mode,
      note: `could not read this month's receipts, so nothing was sent: ${recErr.message}`,
      ...empty
    }
  }
  const receiptCounts = new Map<string, number>()
  for (const r of (receiptRows ?? []) as Array<{ bam_id: string | null }>) {
    if (!r.bam_id) continue
    receiptCounts.set(r.bam_id, (receiptCounts.get(r.bam_id) ?? 0) + 1)
  }

  // The cap goes in the email. A missing ledger row means the month has not been calculated
  // yet, which is normal on the 10th, so it falls back to the standard entitlement.
  const { data: ledgerRows, error: ledErr } = await db
    .from('reimbursement_ledger')
    .select('bam_id, spendable_cap_cad, entitlement_cad')
    .eq('period', period)
  if (ledErr) {
    console.error('[student-reminders] ledger read failed:', ledErr.message)
    return { ran: false, mode: settings.mode, note: `ledger unreadable: ${ledErr.message}`, ...empty }
  }
  const caps = new Map<string, number>()
  for (const r of (ledgerRows ?? []) as Array<{
    bam_id: string; spendable_cap_cad: number | null; entitlement_cad: number | null
  }>) {
    caps.set(r.bam_id, Number(r.spendable_cap_cad ?? r.entitlement_cad ?? 150))
  }

  // Who was already reminded for this period. Checked here so the common case does not rely
  // on catching a unique-violation, though the index is still what guarantees it.
  const { data: sentRows, error: sentErr } = await db
    .from('student_reminders')
    .select('bam_id')
    .eq('period', period)
    .eq('kind', 'deadline')
  if (sentErr) {
    console.error('[student-reminders] prior reminders unreadable:', sentErr.message)
    return {
      ran: false, mode: settings.mode,
      note: `could not check who was already reminded, so nothing was sent: ${sentErr.message}`,
      ...empty
    }
  }
  const already = new Set((sentRows ?? []).map(r => (r as { bam_id: string }).bam_id))

  const errors: string[] = []
  let selected = 0
  let sent = 0
  let failed = 0

  const base = appBaseUrl()
  const label = monthLabel(period)

  for (const b of bams) {
    const candidate: ReminderCandidate = {
      bamId: b.id,
      firstName: b.first_name,
      email: b.email,
      receiptCount: receiptCounts.get(b.id) ?? 0,
      cap: caps.get(b.id) ?? 150,
      isTest: Boolean(b.is_test),
      status: b.status,
      // A null means the column defaulted, which is opted IN. Only an explicit false excludes
      // somebody, so a student who never touched the setting still hears from us.
      wantsReminders: b.wants_reminders !== false
    }

    const plan = planReminder({
      candidate,
      settings,
      day,
      alreadySent: already.has(b.id)
    })
    if (!plan.send) continue
    selected++

    // Claim it first. A duplicate key here means another run already has it.
    const { error: claimErr } = await db.from('student_reminders').insert({
      bam_id: b.id,
      cohort_id: b.cohort_id,
      period,
      kind: 'deadline',
      spent_cad: 0,
      cap_cad: candidate.cap,
      mode: settings.mode
    })
    if (claimErr) {
      // 23505 is unique_violation: somebody else already sent this one. Not an error.
      if (!String(claimErr.message).includes('duplicate key')) {
        errors.push(`${b.id}: could not record the reminder, so it was not sent: ${claimErr.message}`)
        failed++
      }
      continue
    }

    // draft stops here: the row exists, so the Settings page can show exactly who would have
    // been emailed, and nothing left the building.
    if (settings.mode !== 'live') continue

    const mail = reminderEmail({
      firstName: candidate.firstName,
      cap: candidate.cap,
      daysLeft: plan.daysLeft,
      monthLabel: label,
      portalUrl: base
    })

    const err = await sendEmail({
      to: candidate.email as string,
      subject: mail.subject,
      html: mail.html,
      text: mail.text
    }).then(() => null, (e: unknown) => (e as Error).message)

    if (err) {
      failed++
      errors.push(`${candidate.email}: ${err}`)
      const { error: markErr } = await db.from('student_reminders')
        .update({ send_error: err })
        .eq('bam_id', b.id).eq('period', period).eq('kind', 'deadline')
      if (markErr) console.error('[student-reminders] could not record the send error:', markErr.message)
    } else {
      sent++
      // sent_at is stamped only on success, so a null sent_at with no error is a reminder
      // that was claimed and then lost, which is worth being able to see.
      const { error: stampErr } = await db.from('student_reminders')
        .update({ sent_at: new Date().toISOString() })
        .eq('bam_id', b.id).eq('period', period).eq('kind', 'deadline')
      if (stampErr) console.error('[student-reminders] could not stamp sent_at:', stampErr.message)
    }
  }

  return {
    ran: true,
    mode: settings.mode,
    considered: bams.length,
    selected,
    sent,
    failed,
    errors,
    note: settings.mode === 'draft'
      ? `draft only: ${selected} would have been emailed, nothing was sent`
      : undefined
  }
}
