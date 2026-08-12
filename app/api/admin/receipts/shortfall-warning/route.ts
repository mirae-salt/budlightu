/**
 * POST /api/admin/receipts/shortfall-warning  { receipt_id }
 * Sends a friendly warning email to the BAM when their receipt total
 * is below the soft floor (~$140). Called from the receipt decide flow
 * or scheduler audit when shortfall is detected.
 *
 * P0-A: this route had NO authorization check and it SENDS EMAIL to a student
 * (CC'd to Robin). It has two legitimate callers with different credentials:
 *   - the admin UI / a human, which carries a session cookie
 *   - decide/route.ts, which self-fetches server-side with no cookies
 * So it accepts an admin session OR the internal shared secret, the same gate
 * /api/receipts/ocr uses. Anything else denies.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../../lib/send-email'
import { DEFAULT_POLICY, shortfallWarnBelow } from '../../../../../lib/policy'
import { requireAdmin } from '../../../../../lib/admin-auth'
import { cleanEnvValue } from '../../../../../lib/sanitize'

/**
 * True when the caller presented the internal secret. Both sides are sanitized:
 * a BOM on either would otherwise reject every internal call while the env var
 * looked correct (P1-18).
 */
function hasInternalSecret(req: NextRequest): boolean {
  const secret = cleanEnvValue(process.env.INTERNAL_API_SECRET)
  if (!secret) return false
  return cleanEnvValue(req.headers.get('x-internal-secret')) === secret
}

export async function POST(req: NextRequest) {
  if (!hasInternalSecret(req)) {
    const auth = await requireAdmin()
    if (!auth.ok) {
      // Deliberately not `denied(auth)`: this endpoint is also machine-called, so
      // report one shape. Dev without a secret still needs the admin path.
      return NextResponse.json(
        { ok: false, message: 'Not authorized to send shortfall warnings.' },
        { status: auth.status }
      )
    }
  }

  const { receipt_id } = await req.json()
  if (!receipt_id) return NextResponse.json({ ok: false, message: 'receipt_id required' }, { status: 400 })

  const admin = serviceClient()

  const { data: receipt } = await admin.from('receipts')
    .select('bam_id, cohort_id, period, bud_light_total_incl_tax')
    .eq('id', receipt_id).single()
  if (!receipt) return NextResponse.json({ ok: false, message: 'receipt not found' }, { status: 404 })

  const { data: cohort } = await admin.from('cohorts')
    .select('reimbursement_max').eq('id', receipt.cohort_id).single()
  const policy = {
    ...DEFAULT_POLICY,
    reimbursementMax: Number(cohort?.reimbursement_max ?? DEFAULT_POLICY.reimbursementMax)
  }
  const SOFT_FLOOR = shortfallWarnBelow(policy)

  const total = receipt.bud_light_total_incl_tax ?? 0
  if (total >= SOFT_FLOOR) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'above soft floor' })
  }

  const { data: bam } = await admin.from('bams')
    .select('first_name, last_name, email')
    .eq('id', receipt.bam_id).single()
  if (!bam || !bam.email) return NextResponse.json({ ok: false, message: 'BAM not found or no email' }, { status: 404 })

  const period = new Date(receipt.period + 'T00:00:00')
  const monthLabel = period.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  const result = await sendEmail({
    to: bam.email,
    subject: `Bud Light U: receipt shortfall notice for ${monthLabel}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <p style="font-size: 16px; color: #1a1a2e;">Hi ${bam.first_name},</p>
        <p style="font-size: 14px; color: #374151; line-height: 1.6;">
          Your Bud Light receipt for <strong>${monthLabel}</strong> shows a total of
          <strong>$${total.toFixed(2)}</strong>, which is below the expected minimum of $${SOFT_FLOOR}.
        </p>
        <p style="font-size: 14px; color: #374151; line-height: 1.6;">
          This means your reimbursement for this month will be <strong>$${total.toFixed(2)}</strong>
          instead of the full $150 monthly allowance. You will still receive your full salary.
        </p>
        <p style="font-size: 14px; color: #374151; line-height: 1.6;">
          If you have additional Bud Light receipts for this month, please upload them through the portal
          before the review deadline. If you have questions, reach out to your program manager.
        </p>
        <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">
          - Bud Light U Automation
        </p>
      </div>
    `,
    text: `Hi ${bam.first_name},\n\nYour Bud Light receipt for ${monthLabel} shows $${total.toFixed(2)}, below the $${SOFT_FLOOR} soft floor. Your reimbursement will be $${total.toFixed(2)} instead of the full $150. Upload additional receipts before the deadline if you have them.\n\n- Bud Light U`
  })

  return NextResponse.json({ ok: result.sent, provider: result.provider, error: result.error })
}
