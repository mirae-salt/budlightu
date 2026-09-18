/**
 * Student notification writer. The counterpart to notify-admin.ts, deliberately shaped the
 * same way so the two read alike.
 *
 * WHAT THIS IS
 * ------------
 * A STATUS BOARD entry: "your receipt was accepted", "your invoice went to accounts payable".
 * Records, one line each, with a link to the page that shows the detail. Per the channel rule
 * in CLAUDE.md, a record goes to BOTH the bell and email; a conversation goes to email. This
 * writes the bell half. It never sends anything, so a caller that only calls this has NOT
 * notified anybody who is not already looking at the portal.
 *
 * It must not become an inbox. Threads live in portal_question_messages (0027).
 *
 * WHY IT REPORTS ITS RESULT
 * -------------------------
 * supabase-js does not throw, so wrapping an insert in try/catch produces an unreachable catch
 * and an unread `error`. That exact pattern lost admin notifications (P1-17) and, on
 * 2026-08-13, lost three emails that were reported as delivered. Callers get `ok` back and the
 * failure is logged with the notification that was dropped, so it can be replayed by hand.
 *
 * Nothing here should abort the operation that triggered it: a receipt decision is worth
 * keeping even when the bell entry fails. So the default is fire and report, and
 * `notifyBamOrThrow` exists for the case where that stops being true.
 */
import { serviceClient } from '../supabase/functions/_shared/supabase-admin'

/**
 * Free text in the database, a union here. The panel's colour lookup falls back to grey for
 * anything it does not know, so adding a kind needs no migration and no CSS.
 */
export type BamNotifType =
  /** A receipt was accepted in review. */
  | 'receipt_approved'
  /** A receipt was not accepted. Actionable: they can upload another before the deadline. */
  | 'receipt_rejected'
  /**
   * Their invoice is final and published to them, and their 24-hour window to object
   * has started (2026-09-16, Legal). Actionable, and time-limited: this is the only
   * notification a BAM has to act on before a deadline they did not set.
   */
  | 'invoice_review'
  /** Their invoice was sent to accounts payable. */
  | 'invoice_sent'
  /** They spent under the soft floor for the month. */
  | 'shortfall'
  /** Somebody answered their support question. */
  | 'question_answered'
  /**
   * Their banking details on file were changed. Sent whoever made the change, including
   * when an admin applied it: a student who did not ask for it is the only person who can
   * tell us the change was wrong, and they cannot read their own stored numbers back.
   */
  | 'banking_changed'

export interface BamNotification {
  bam_id: string
  type: BamNotifType
  title: string
  body?: string
  /**
   * A PORTAL route. An /admin path here would send a student to a page the middleware refuses,
   * so the shape is checked below rather than trusted.
   */
  link?: string
  /** The month it is about, ISO date, when it is about a month. */
  period?: string
}

export type NotifyBamResult = { ok: true; id: string } | { ok: false; error: string }

/**
 * Rejects anything that is not a portal path, including absolute URLs and /admin.
 *
 * Exported for the test. A wrong link here is not cosmetic: a student who taps a notification
 * pointing at /admin/receipts is bounced by the middleware and lands on a page that looks like
 * the portal is broken, and an absolute URL is how a notification becomes an open redirect.
 */
export function portalLink(link: string | undefined, type: string): string | null {
  if (!link) return null
  if (link.startsWith('/portal/')) return link
  console.error(`[notifyBam] refusing non-portal link on ${type}: ${link}`)
  return null
}

export async function notifyBam(n: BamNotification): Promise<NotifyBamResult> {
  if (!n.bam_id) {
    const error = 'no bam_id'
    console.error('[notifyBam] DROPPED notification:', n.type, n.title, '-', error)
    return { ok: false, error }
  }

  let db
  try {
    db = serviceClient()
  } catch (e) {
    // serviceClient() throws when env vars are missing. That is the only throw on this path,
    // and it is a configuration fault, not a query error.
    const error = `service client unavailable: ${(e as Error).message}`
    console.error('[notifyBam] DROPPED notification:', n.type, n.title, '-', error)
    return { ok: false, error }
  }

  const { data, error } = await db.from('bam_notifications').insert({
    bam_id: n.bam_id,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    link: portalLink(n.link, n.type),
    period: n.period ?? null,
  }).select('id')

  if (error) {
    console.error('[notifyBam] DROPPED notification:', n.type, n.title, '-', error.message)
    return { ok: false, error: error.message }
  }

  const rows = (data ?? []) as { id: string }[]
  if (rows.length === 0) {
    // Insert reported no error and no row. Do not call that a success.
    const msg = 'insert returned no row'
    console.error('[notifyBam] DROPPED notification:', n.type, n.title, '-', msg)
    return { ok: false, error: msg }
  }

  return { ok: true, id: rows[0].id }
}

/** Use where a lost notification must fail the surrounding operation. */
export async function notifyBamOrThrow(n: BamNotification): Promise<string> {
  const res = await notifyBam(n)
  if (!res.ok) throw new Error(`BAM notification failed: ${res.error}`)
  return res.id
}
