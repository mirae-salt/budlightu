/**
 * POST /api/admin/receipts/shortfall-warning  { receipt_id }
 * Sends a friendly warning email to the BAM when their receipt total
 * is below the soft floor (~$140). Called from the receipt decide flow
 * or scheduler audit when shortfall is detected.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../../lib/send-email'
import { DEFAULT_POLICY, softFloorFor } from '../../../../../lib/policy'

export async function POST(req: NextRequest) {
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
  const SOFT_FLOOR = softFloorFor(policy)

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
    subject: `Bud Light U — Receipt shortfall notice for ${monthLabel}`,
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
          — Bud Light U Automation
        </p>
      </div>
    `,
    text: `Hi ${bam.first_name},\n\nYour Bud Light receipt for ${monthLabel} shows $${total.toFixed(2)}, below the $${SOFT_FLOOR} soft floor. Your reimbursement will be $${total.toFixed(2)} instead of the full $150. Upload additional receipts before the deadline if you have them.\n\n— Bud Light U`
  })

  return NextResponse.json({ ok: result.sent, provider: result.provider, error: result.error })
}
