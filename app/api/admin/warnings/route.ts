/**
 * GET  /api/admin/warnings?bam_id=...&cohort_id=...
 *   List warnings for a BAM (or all if no bam_id).
 *
 * POST /api/admin/warnings
 *   { bam_id, cohort_id, period, spent, action }
 *   action = "flag"   → create warning record, email Robin
 *   action = "send"   → mark warning as sent, email BAM
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../lib/send-email'

const ROBIN_EMAIL = 'robin.graham@ilovesalt.com'
const NATHAN_EMAIL = 'nb@ilovesalt.com'
const REEVALUATE_THRESHOLD = 2

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const bamId = sp.get('bam_id')
  const cohortId = sp.get('cohort_id')

  const admin = serviceClient()
  let q = admin.from('bam_warnings')
    .select('*, bams(first_name, last_name, email)')
    .order('created_at', { ascending: false })

  if (bamId) q = q.eq('bam_id', bamId)
  if (cohortId) q = q.eq('cohort_id', cohortId)

  const { data, error } = await q
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, data })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { bam_id, cohort_id, period, spent, action, notes, admin_email } = body

  if (!bam_id || !cohort_id || !period) {
    return NextResponse.json({ ok: false, message: 'bam_id, cohort_id, period required' }, { status: 400 })
  }

  const admin = serviceClient()

  const { data: bam } = await admin.from('bams')
    .select('first_name, last_name, email')
    .eq('id', bam_id).single()
  if (!bam) return NextResponse.json({ ok: false, message: 'BAM not found' }, { status: 404 })

  const bamName = `${bam.first_name} ${bam.last_name}`

  if (action === 'flag') {
    const { count } = await admin.from('bam_warnings')
      .select('id', { count: 'exact', head: true })
      .eq('bam_id', bam_id)
      .eq('cohort_id', cohort_id)

    const warningNumber = (count ?? 0) + 1
    const needsReevaluation = warningNumber >= REEVALUATE_THRESHOLD

    const { data: existing } = await admin.from('bam_warnings')
      .select('id')
      .eq('bam_id', bam_id)
      .eq('cohort_id', cohort_id)
      .eq('period', period)
      .maybeSingle()

    if (existing) {
      return NextResponse.json({ ok: true, skipped: true, reason: 'already flagged for this period' })
    }

    const { data: warning, error } = await admin.from('bam_warnings').insert({
      bam_id,
      cohort_id,
      period,
      spent: spent ?? 0,
      warning_number: warningNumber,
      notes,
    }).select().single()

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

    const monthLabel = formatMonth(period)
    const reevalLine = needsReevaluation
      ? `\n\n⚠️ This is warning #${warningNumber} for ${bamName}. Per policy, their standing in the program should be reevaluated.`
      : ''

    await sendEmail({
      to: ROBIN_EMAIL,
      cc: [NATHAN_EMAIL],
      subject: `BLU low-spend alert: ${bamName} — ${monthLabel} ($${(spent ?? 0).toFixed(2)})${needsReevaluation ? ' ⚠️ REEVALUATE' : ''}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
          <p style="font-size: 16px; color: #1a1a2e;">Low-spend alert</p>
          <table style="font-size: 14px; color: #374151; line-height: 1.8; border-collapse: collapse;">
            <tr><td style="padding-right: 16px; font-weight: 600;">BAM</td><td>${bamName}</td></tr>
            <tr><td style="padding-right: 16px; font-weight: 600;">Month</td><td>${monthLabel}</td></tr>
            <tr><td style="padding-right: 16px; font-weight: 600;">Spent</td><td>$${(spent ?? 0).toFixed(2)} / $150.00</td></tr>
            <tr><td style="padding-right: 16px; font-weight: 600;">Warning #</td><td>${warningNumber}</td></tr>
          </table>
          ${needsReevaluation ? '<p style="font-size: 14px; color: #DC2626; font-weight: 600; margin-top: 16px;">⚠️ This BAM has reached ' + warningNumber + ' warnings. Please reevaluate their standing in the program.</p>' : ''}
          <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">
            You can send a warning email to the BAM from the admin dashboard, or take other action as needed.
          </p>
          <p style="font-size: 12px; color: #9ca3af; margin-top: 16px;">— BLU Automation</p>
        </div>
      `,
      text: `Low-spend alert\n\nBAM: ${bamName}\nMonth: ${monthLabel}\nSpent: $${(spent ?? 0).toFixed(2)} / $150\nWarning #${warningNumber}${reevalLine}\n\n— BLU Automation`
    })

    return NextResponse.json({
      ok: true,
      warning,
      warningNumber,
      needsReevaluation,
      notifiedRobin: true,
    })
  }

  if (action === 'send') {
    const { data: warning } = await admin.from('bam_warnings')
      .select('*')
      .eq('bam_id', bam_id)
      .eq('cohort_id', cohort_id)
      .eq('period', period)
      .maybeSingle()

    if (!warning) return NextResponse.json({ ok: false, message: 'no warning record for this period' }, { status: 404 })
    if (warning.sent_at) return NextResponse.json({ ok: true, skipped: true, reason: 'already sent' })

    const monthLabel = formatMonth(period)

    const result = await sendEmail({
      to: bam.email,
      cc: [ROBIN_EMAIL],
      subject: `Bud Light U — Spending reminder for ${monthLabel}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
          <p style="font-size: 16px; color: #1a1a2e;">Hi ${bam.first_name},</p>
          <p style="font-size: 14px; color: #374151; line-height: 1.6;">
            We noticed your Bud Light purchases for <strong>${monthLabel}</strong> totaled
            <strong>$${warning.spent.toFixed(2)}</strong>, which is below the $150 monthly reimbursement allowance.
          </p>
          <p style="font-size: 14px; color: #374151; line-height: 1.6;">
            As a reminder, you're encouraged to use your full $150/month allowance on Bud Light products.
            Your reimbursement for this month will match what you spent.
          </p>
          <p style="font-size: 14px; color: #374151; line-height: 1.6;">
            If you have any questions or concerns, please reach out to your program manager.
          </p>
          <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">— Bud Light U Program</p>
        </div>
      `,
      text: `Hi ${bam.first_name},\n\nYour Bud Light purchases for ${monthLabel} totaled $${warning.spent.toFixed(2)}, below the $150 monthly allowance. Please try to use your full allowance. Your reimbursement will match what you spent.\n\nIf you have questions, reach out to your program manager.\n\n— Bud Light U Program`
    })

    if (result.sent) {
      await admin.from('bam_warnings')
        .update({ sent_at: new Date().toISOString(), sent_by: admin_email ?? 'system' })
        .eq('id', warning.id)
    }

    return NextResponse.json({
      ok: result.sent,
      provider: result.provider,
      error: result.error,
    })
  }

  return NextResponse.json({ ok: false, message: 'action must be "flag" or "send"' }, { status: 400 })
}

function formatMonth(period: string): string {
  const [y, m] = period.split('-')
  const d = new Date(parseInt(y), parseInt(m) - 1, 1)
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
