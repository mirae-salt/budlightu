/**
 * Shortfall flagging (the "warn → 2 consecutive shortfalls → reevaluate" rule,
 * Robin 2026-08-04).
 *
 * Extracted from app/api/admin/warnings so the receipt decide flow can call it
 * directly instead of firing an unawaited HTTP request at our own API. Two audit
 * findings meet here:
 *
 *   P1-12: the route reported `notifiedManager: true` unconditionally, discarding the
 *          sendEmail result. This email is the ONLY mechanism that tells Robin a BAM
 *          underspent, i.e. the trigger for the reevaluate rule. A silent provider
 *          failure meant the warning simply never happened while the UI said it did.
 *   P0-H:  every supabase call here is error-checked, and the returned shape says
 *          what actually happened rather than assuming success.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from './send-email'

export const ROBIN_EMAIL = 'robin.graham@ilovesalt.com'
export const NATHAN_EMAIL = 'nb@ilovesalt.com'
export const REEVALUATE_THRESHOLD = 2

/**
 * The month before an ISO first-of-month period string. Pure string arithmetic, not
 * Date parsing, so it cannot shift a month across a timezone boundary.
 */
export function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number)
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return `${py}-${String(pm).padStart(2, '0')}-01`
}

/**
 * How many periods IN A ROW, counting back from `period`, have a warning.
 *
 * Reevaluation is a CONSECUTIVE rule (two shortfalls in a row), which is what Robin
 * confirmed over Teams. The code counted total warnings for the cohort instead, so a
 * BAM who underspent in September and again in February was flagged as though it had
 * happened twice running. Two isolated months are not the same situation as two in a
 * row, and the second is the one that means something.
 *
 * `period` itself counts as 1 when present, so the caller includes the row it is
 * about to insert.
 */
export function consecutiveWarningStreak(warnedPeriods: readonly string[], period: string): number {
  const set = new Set(warnedPeriods)
  let streak = 0
  let cursor = period
  while (set.has(cursor)) {
    streak++
    cursor = previousPeriod(cursor)
  }
  return streak
}

/**
 * bam_warnings.period is TEXT "YYYY-MM" (0011_bam_warnings.sql) while
 * receipts.period is a DATE "YYYY-MM-01". Callers passed both, so the same month
 * could produce two warning rows under the UNIQUE(bam_id, cohort_id, period)
 * constraint and inflate the reevaluate counter. Normalize on the way in.
 */
export function normalizeWarningPeriod(period: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(String(period).trim())
  return m ? `${m[1]}-${m[2]}` : String(period).trim()
}

export function formatWarningMonth(period: string): string {
  const [y, m] = normalizeWarningPeriod(period).split('-')
  const d = new Date(Number(y), Number(m) - 1, 1)
  if (isNaN(d.getTime())) return period
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export type FlagShortfallInput = {
  bamId: string
  cohortId: string
  period: string
  spent: number
  cap?: number
  notes?: string | null
}

export type FlagShortfallResult = {
  ok: boolean
  skipped?: boolean
  reason?: string
  warning?: unknown
  warningNumber?: number
  needsReevaluation?: boolean
  /** true ONLY if the provider confirmed the send */
  notifiedManager: boolean
  notifyProvider?: string
  notifyError?: string
  error?: string
  status?: number
}

export type FlagShortfallOptions = {
  /**
   * Whether to email the program manager. Defaults to true, which is the behaviour
   * every caller had before this existed.
   *
   * The receipt decide flow passes false (Mirae, 2026-08-26: "shortfall detected is
   * an email nobody needs"). Approving a receipt under the floor fired two automatic
   * emails, one to the manager and one to the student, on every single approval. At
   * 58 BAMs that is a monthly wave of mail announcing something already visible on
   * the dashboard, and during testing it was one alert per test receipt.
   *
   * What is switched off is the AUTOMATIC send. The warning row and the in-app
   * notification are unaffected, so the "two consecutive shortfalls means reevaluate"
   * count (Robin 2026-08-04) still advances exactly as before, and /admin/warnings
   * still emails when a human deliberately presses the button. The manager email even
   * said so itself: "You can send a warning email to the BAM from the admin dashboard."
   */
  sendManagerEmail?: boolean
}

export async function flagShortfall(
  admin: SupabaseClient,
  input: FlagShortfallInput,
  opts: FlagShortfallOptions = {}
): Promise<FlagShortfallResult> {
  const sendManagerEmail = opts.sendManagerEmail !== false
  const period = normalizeWarningPeriod(input.period)
  const spent = Number.isFinite(input.spent) ? input.spent : 0

  const { data: bam, error: bamErr } = await admin.from('bams')
    .select('first_name, last_name, email')
    .eq('id', input.bamId).maybeSingle()
  if (bamErr) return { ok: false, notifiedManager: false, error: `bams lookup failed: ${bamErr.message}`, status: 500 }
  if (!bam) return { ok: false, notifiedManager: false, error: 'BAM not found', status: 404 }

  const bamName = `${bam.first_name} ${bam.last_name}`

  const { data: existing, error: existingErr } = await admin.from('bam_warnings')
    .select('id')
    .eq('bam_id', input.bamId)
    .eq('cohort_id', input.cohortId)
    .eq('period', period)
    .maybeSingle()
  if (existingErr) {
    return { ok: false, notifiedManager: false, error: `warning lookup failed: ${existingErr.message}`, status: 500 }
  }
  if (existing) {
    return { ok: true, skipped: true, reason: 'already flagged for this period', notifiedManager: false }
  }

  // The PERIODS, not just how many. Reevaluation is a consecutive rule, so a count
  // cannot answer it. See consecutiveWarningStreak above.
  const { data: priorWarnings, error: countErr } = await admin.from('bam_warnings')
    .select('period')
    .eq('bam_id', input.bamId)
    .eq('cohort_id', input.cohortId)
  if (countErr) {
    return { ok: false, notifiedManager: false, error: `warning lookup failed: ${countErr.message}`, status: 500 }
  }

  const priorPeriods = (priorWarnings ?? []).map(w => String(w.period))
  const warningNumber = priorPeriods.length + 1
  // Include the period being warned about now: the row is not inserted yet.
  const streak = consecutiveWarningStreak([...priorPeriods, period], period)
  const needsReevaluation = streak >= REEVALUATE_THRESHOLD

  const insertRow: Record<string, unknown> = {
    bam_id: input.bamId,
    cohort_id: input.cohortId,
    period,
    spent,
    warning_number: warningNumber,
    notes: input.notes ?? null,
  }
  if (input.cap != null && Number.isFinite(input.cap)) insertRow.cap = input.cap

  const { data: warning, error: insErr } = await admin.from('bam_warnings')
    .insert(insertRow).select().single()
  if (insErr) {
    return { ok: false, notifiedManager: false, error: `could not record warning: ${insErr.message}`, status: 500 }
  }

  const monthLabel = formatWarningMonth(period)
  const capLabel = input.cap != null && Number.isFinite(input.cap) ? input.cap.toFixed(2) : '150.00'
  const reevalLine = needsReevaluation
    ? `\n\nThis is ${streak} shortfall months in a row for ${bamName} (warning #${warningNumber} overall). Per policy, their standing in the program should be reevaluated.`
    : ''

  if (!sendManagerEmail) {
    // The warning is on the record and the streak has advanced; only the automatic
    // email is skipped. Reported as notifiedManager:false with a reason, never as a
    // silent success, so a caller can never print "manager notified" from this.
    return {
      ok: true,
      warning,
      warningNumber,
      needsReevaluation,
      notifiedManager: false,
      notifyProvider: 'skipped',
      reason: 'automatic shortfall email is off; the warning was recorded',
      status: 200
    }
  }

  const result = await sendEmail({
    to: ROBIN_EMAIL,
    cc: [NATHAN_EMAIL],
    subject: `BLU low-spend alert: ${bamName} - ${monthLabel} ($${spent.toFixed(2)})${needsReevaluation ? ' [REEVALUATE]' : ''}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <p style="font-size: 16px; color: #1a1a2e;">Low-spend alert</p>
        <table style="font-size: 14px; color: #374151; line-height: 1.8; border-collapse: collapse;">
          <tr><td style="padding-right: 16px; font-weight: 600;">BAM</td><td>${bamName}</td></tr>
          <tr><td style="padding-right: 16px; font-weight: 600;">Month</td><td>${monthLabel}</td></tr>
          <tr><td style="padding-right: 16px; font-weight: 600;">Spent</td><td>$${spent.toFixed(2)} / $${capLabel}</td></tr>
          <tr><td style="padding-right: 16px; font-weight: 600;">Warning #</td><td>${warningNumber}</td></tr>
        </table>
        ${needsReevaluation ? `<p style="font-size: 14px; color: #DC2626; font-weight: 600; margin-top: 16px;">This BAM has reached ${warningNumber} warnings. Please reevaluate their standing in the program.</p>` : ''}
        <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">
          You can send a warning email to the BAM from the admin dashboard, or take other action as needed.
        </p>
        <p style="font-size: 12px; color: #9ca3af; margin-top: 16px;">Bud Light U Automation</p>
      </div>
    `,
    text: `Low-spend alert\n\nBAM: ${bamName}\nMonth: ${monthLabel}\nSpent: $${spent.toFixed(2)} / $${capLabel}\nWarning #${warningNumber}${reevalLine}\n\nBud Light U Automation`
  })

  if (!result.sent) {
    // Record the failure on the row so it is recoverable, and do NOT claim success.
    const { error: noteErr } = await admin.from('bam_warnings')
      .update({
        notes: [input.notes, `admin alert email FAILED (${result.provider}): ${result.error ?? 'unknown error'}`]
          .filter(Boolean).join(' | ')
      })
      .eq('id', (warning as { id: string }).id)
    if (noteErr) console.error('[flagShortfall] could not record notify failure:', noteErr.message)
  }

  return {
    ok: result.sent,
    warning,
    warningNumber,
    needsReevaluation,
    notifiedManager: result.sent,
    notifyProvider: result.provider,
    notifyError: result.error,
    error: result.sent ? undefined : `warning recorded but the alert email to the program manager failed: ${result.error ?? 'unknown error'}`,
    status: result.sent ? 200 : 502
  }
}

export type ResolveCaughtUpResult =
  | { ok: true; cleared: boolean }
  | { ok: false; error: string }

/**
 * Deletes a period's shortfall warning once that period's own total has caught back
 * up past the floor, but only if the warning was never actually sent.
 *
 * flagShortfall fires on the FIRST receipt that puts a period below the floor and then
 * refuses to touch that period again ("already flagged for this period"), so a BAM who
 * submits a light receipt and tops up later in the same month keeps the badge forever.
 * Elizabeth Bennett's dashboard row was exactly this: warned at $38.99 on her first
 * receipt, $182.57 for the month by her third, still showing "1x warn" days later.
 * A scan on 2026-09-14 found 13 of 24 recorded warnings in this same stale state.
 *
 * A SENT warning is left alone -- it already reached Robin, and deleting a record of
 * something that happened is the one cleanup nobody should automate (same rule as
 * audit_log). An unsent one never reached anyone, so there is nothing to preserve:
 * the row exists only to gate the dashboard badge and the reevaluate streak, and both
 * should reflect the period's real outcome once it has one.
 *
 * Call this whenever a ledger recompute finds the period NOT below the floor anymore
 * (the mirror image of the `if (belowWarnFloor) flagShortfall(...)` call sites).
 */
export async function resolveCaughtUpShortfall(
  admin: SupabaseClient,
  input: { bamId: string; cohortId: string; period: string }
): Promise<ResolveCaughtUpResult> {
  const period = normalizeWarningPeriod(input.period)

  const { data: existing, error: findErr } = await admin.from('bam_warnings')
    .select('id, sent_at')
    .eq('bam_id', input.bamId)
    .eq('cohort_id', input.cohortId)
    .eq('period', period)
    .maybeSingle()
  if (findErr) return { ok: false, error: `warning lookup failed: ${findErr.message}` }
  if (!existing) return { ok: true, cleared: false }
  if (existing.sent_at) return { ok: true, cleared: false }

  const { data: deleted, error: delErr } = await admin.from('bam_warnings')
    .delete()
    .eq('id', existing.id)
    .select('id')
  if (delErr) return { ok: false, error: `could not clear stale warning: ${delErr.message}` }
  if (!deleted || deleted.length !== 1) {
    return { ok: false, error: `delete matched ${deleted?.length ?? 0} rows, expected 1` }
  }

  return { ok: true, cleared: true }
}
