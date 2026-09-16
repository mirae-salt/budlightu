/**
 * Admin notification writer.
 *
 * P1-17: this function used to wrap the insert in try/catch. supabase-js does
 * NOT throw, so the catch was unreachable and the insert's `error` was never
 * read. Every admin notification (receipt review, shortfall, support question)
 * could vanish with no trace, which silently disables Robin's touchpoint 1.
 *
 * It now inspects `error` and returns the outcome. The exported name and the
 * single-argument call shape are unchanged, so existing fire-and-forget callers
 * keep compiling; callers that care can check the returned `ok`.
 *
 *   const res = await notifyAdmin({ ... })
 *   if (!res.ok) { // the notification did not land
 *
 * `notifyAdminOrThrow` is available where a lost notification should abort the
 * surrounding operation.
 */
import { serviceClient } from '../supabase/functions/_shared/supabase-admin'

type NotifType =
  | 'receipt_review'
  | 'ocr_failed'
  | 'shortfall'
  | 'invoice_draft'
  /**
   * A BAM objected to their own invoice during the 24-hour window (0035). Distinct from
   * 'invoice_draft', which means an invoice could not be built: this one means the
   * figure is fine as far as we know and the person being paid disagrees. It also
   * blocks the AP send until somebody resolves it, so it needs its own colour.
   */
  | 'invoice_dispute'
  | 'support_question'
  | 'receipt_uploaded'
  /** BAM asked for a banking correction; an admin has to apply it (0022). */
  | 'banking_change_request'

interface AdminNotification {
  type: NotifType
  title: string
  body?: string
  bam_id?: string
  cohort_id?: string
  period?: string
  link?: string
}

export type NotifyResult = { ok: true; id: string | null } | { ok: false; error: string }

export async function notifyAdmin(n: AdminNotification): Promise<NotifyResult> {
  let db
  try {
    db = serviceClient()
  } catch (e) {
    // serviceClient() throws when env vars are missing. That is the only throw
    // on this path, and it is a configuration fault, not a query error.
    const error = `service client unavailable: ${(e as Error).message}`
    console.error('[notifyAdmin] DROPPED notification:', n.type, n.title, '-', error)
    return { ok: false, error }
  }

  const { data, error } = await db.from('admin_notifications').insert({
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    bam_id: n.bam_id ?? null,
    cohort_id: n.cohort_id ?? null,
    period: n.period ?? null,
    link: n.link ?? null,
  }).select('id')

  if (error) {
    console.error('[notifyAdmin] DROPPED notification:', n.type, n.title, '-', error.message)
    return { ok: false, error: error.message }
  }

  const rows = (data ?? []) as { id: string }[]
  if (rows.length === 0) {
    // Insert reported no error and no row. Do not call that a success.
    const msg = 'insert returned no row'
    console.error('[notifyAdmin] DROPPED notification:', n.type, n.title, '-', msg)
    return { ok: false, error: msg }
  }

  return { ok: true, id: rows[0].id }
}

/** Use where a lost notification must fail the surrounding operation. */
export async function notifyAdminOrThrow(n: AdminNotification): Promise<string | null> {
  const res = await notifyAdmin(n)
  if (!res.ok) throw new Error(`admin notification failed: ${res.error}`)
  return res.id
}

/*
 * CLOSING NOTIFICATIONS, added 2026-09-08.
 *
 * Until now the bell only counted up. A notification became read when somebody clicked it
 * or clicked "mark all read", and nothing ever closed one because the work behind it was
 * finished. On 2026-09-08 the bell said 27 and 13 of those were for receipts that had
 * already been decided, including nine cleared by a script an hour earlier.
 *
 * A counter that is mostly wrong is worse than no counter, because the number stops
 * meaning "things waiting for you" and starts meaning "things that have ever happened",
 * and then nobody opens it.
 *
 * This closes them from the state rather than from the click: it asks whether anything is
 * still open for that BAM and month, and only then marks the notifications read. Safe to
 * call from anywhere and safe to call twice.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NotifyDb = { from: (...args: any[]) => any }

export type SyncResult = { ok: true; closed: number } | { ok: false; error: string }

/** Receipt states that keep a `receipt_review` / `ocr_failed` notification open. */
const OPEN_STATE_FOR: Partial<Record<NotifType, string>> = {
  receipt_review: 'review',
  ocr_failed: 'ocr_failed'
}

/**
 * Marks a BAM's open receipt notifications read once no receipt of theirs is still in
 * that state for the period.
 *
 * The per-BAM-and-period check matters: Emma Crowder had two receipts in review at once,
 * and closing her notifications when the first was decided would have hidden the second.
 */
export async function syncAdminNotifications(
  db: NotifyDb,
  args: { bamId: string; period: string }
): Promise<SyncResult> {
  const { data: receipts, error: rErr } = await db.from('receipts')
    .select('status')
    .eq('bam_id', args.bamId)
    .eq('period', args.period)
  if (rErr) return { ok: false, error: `receipts unreadable: ${rErr.message}` }

  const statuses = new Set((receipts ?? []).map((r: { status: string }) => r.status))
  const finished = (Object.keys(OPEN_STATE_FOR) as NotifType[])
    .filter(type => !statuses.has(OPEN_STATE_FOR[type] as string))
  if (finished.length === 0) return { ok: true, closed: 0 }

  const { data, error } = await db.from('admin_notifications')
    .update({ read: true })
    .eq('bam_id', args.bamId)
    .eq('period', args.period)
    .eq('read', false)
    .in('type', finished)
    .select('id')
  if (error) return { ok: false, error: `notifications not closed: ${error.message}` }

  return { ok: true, closed: (data ?? []).length }
}

/**
 * Is there already an unread notification saying this?
 *
 * Three receipts in a month produced three "Shortfall detected" for the same person, two
 * of them on the same day, each quoting a different running total. Only the last one was
 * ever true. A second copy of an open item is not new information.
 */
export async function hasOpenNotification(
  db: NotifyDb,
  args: { type: NotifType; bamId?: string | null; period?: string | null }
): Promise<boolean> {
  if (!args.bamId || !args.period) return false
  const { data, error } = await db.from('admin_notifications')
    .select('id')
    .eq('type', args.type)
    .eq('bam_id', args.bamId)
    .eq('period', args.period)
    .eq('read', false)
    .limit(1)
  // Unreadable means unknown, and a duplicate notification is better than a lost one.
  if (error) return false
  return (data ?? []).length > 0
}
