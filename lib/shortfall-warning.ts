/**
 * Shortfall flagging (the "warn → 2 consecutive shortfalls → reevaluate" rule,
 * Robin 2026-08-04).
 *
 * Extracted from app/api/admin/warnings so the receipt decide flow can call it
 * directly instead of firing an unawaited HTTP request at our own API. Two audit
 * findings meet here:
 *
 *   P1-12: the route reported `notifiedRobin: true` unconditionally, discarding the
 *          sendEmail result. This email is the ONLY mechanism that tells Robin a BAM
 *          underspent, i.e. the trigger for the reevaluate rule. A silent provider
 *          failure meant the warning simply never happened while the UI said it did.
 *   P0-H:  every supabase call here is error-checked, and the returned shape says
 *          what actually happened rather than assuming success.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from './send-email'

export const ROBIN_EMAIL = 'robin.graham@ilovesalt.com'
export const NATHAN_EMAIL = 'nb@ilovesalt.com'
export const REEVALUATE_THRESHOLD = 2

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
  notifiedRobin: boolean
  notifyProvider?: string
  notifyError?: string
  error?: string
  status?: number
}

export async function flagShortfall(
  admin: SupabaseClient,
  input: FlagShortfallInput
): Promise<FlagShortfallResult> {
  const period = normalizeWarningPeriod(input.period)
  const spent = Number.isFinite(input.spent) ? input.spent : 0

  const { data: bam, error: bamErr } = await admin.from('bams')
    .select('first_name, last_name, email')
    .eq('id', input.bamId).maybeSingle()
  if (bamErr) return { ok: false, notifiedRobin: false, error: `bams lookup failed: ${bamErr.message}`, status: 500 }
  if (!bam) return { ok: false, notifiedRobin: false, error: 'BAM not found', status: 404 }

  const bamName = `${bam.first_name} ${bam.last_name}`

  const { data: existing, error: existingErr } = await admin.from('bam_warnings')
    .select('id')
    .eq('bam_id', input.bamId)
    .eq('cohort_id', input.cohortId)
    .eq('period', period)
    .maybeSingle()
  if (existingErr) {
    return { ok: false, notifiedRobin: false, error: `warning lookup failed: ${existingErr.message}`, status: 500 }
  }
  if (existing) {
    return { ok: true, skipped: true, reason: 'already flagged for this period', notifiedRobin: false }
  }

  const { count, error: countErr } = await admin.from('bam_warnings')
    .select('id', { count: 'exact', head: true })
    .eq('bam_id', input.bamId)
    .eq('cohort_id', input.cohortId)
  if (countErr) {
    return { ok: false, notifiedRobin: false, error: `warning count failed: ${countErr.message}`, status: 500 }
  }

  const warningNumber = (count ?? 0) + 1
  const needsReevaluation = warningNumber >= REEVALUATE_THRESHOLD

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
    return { ok: false, notifiedRobin: false, error: `could not record warning: ${insErr.message}`, status: 500 }
  }

  const monthLabel = formatWarningMonth(period)
  const capLabel = input.cap != null && Number.isFinite(input.cap) ? input.cap.toFixed(2) : '150.00'
  const reevalLine = needsReevaluation
    ? `\n\nThis is warning #${warningNumber} for ${bamName}. Per policy, their standing in the program should be reevaluated.`
    : ''

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
    notifiedRobin: result.sent,
    notifyProvider: result.provider,
    notifyError: result.error,
    error: result.sent ? undefined : `warning recorded but the alert email to Robin failed: ${result.error ?? 'unknown error'}`,
    status: result.sent ? 200 : 502
  }
}
