/**
 * GET  /api/admin/warnings?bam_id=...&cohort_id=...
 *   List warnings for a BAM (or all if no bam_id).
 *
 * POST /api/admin/warnings
 *   { bam_id, cohort_id, period, spent, action }
 *   action = "flag"   → create warning record, email Robin
 *   action = "send"   → mark warning as sent, email BAM
 *
 * P0-A: neither handler had ANY authorization check. GET returned every BAM's
 * name and email address to anonymous callers, and POST could email a student a
 * spending warning (CC Robin) from an unauthenticated request. Both now require
 * an admin, with the role read from app_metadata only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../lib/send-email'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import {
  flagShortfall,
  formatWarningMonth,
  normalizeWarningPeriod,
  ROBIN_EMAIL
} from '../../../../lib/shortfall-warning'

export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

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
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const body = await req.json()
  const { bam_id, cohort_id, period, spent, action, notes, admin_email } = body

  if (!bam_id || !cohort_id || !period) {
    return NextResponse.json({ ok: false, message: 'bam_id, cohort_id, period required' }, { status: 400 })
  }

  const admin = serviceClient()

  const { data: bam, error: bamErr } = await admin.from('bams')
    .select('first_name, last_name, email')
    .eq('id', bam_id).maybeSingle()
  if (bamErr) return NextResponse.json({ ok: false, error: bamErr.message }, { status: 500 })
  if (!bam) return NextResponse.json({ ok: false, message: 'BAM not found' }, { status: 404 })

  if (action === 'flag') {
    // P1-12: the send result decides the response. `notifiedRobin` is no longer
    // asserted; it reports what the provider actually confirmed.
    const result = await flagShortfall(admin, {
      bamId: bam_id,
      cohortId: cohort_id,
      period,
      spent: Number(spent ?? 0),
      notes,
    })
    return NextResponse.json(result, { status: result.status ?? (result.ok ? 200 : 500) })
  }

  if (action === 'send') {
    const warningPeriod = normalizeWarningPeriod(period)
    const { data: warning, error: warnErr } = await admin.from('bam_warnings')
      .select('*')
      .eq('bam_id', bam_id)
      .eq('cohort_id', cohort_id)
      .eq('period', warningPeriod)
      .maybeSingle()

    if (warnErr) return NextResponse.json({ ok: false, error: warnErr.message }, { status: 500 })
    if (!warning) return NextResponse.json({ ok: false, message: 'no warning record for this period' }, { status: 404 })
    if (warning.sent_at) return NextResponse.json({ ok: true, skipped: true, reason: 'already sent' })

    const monthLabel = formatWarningMonth(warningPeriod)

    const spentLabel = Number(warning.spent ?? 0).toFixed(2)
    const capLabel = Number(warning.cap ?? 150).toFixed(2)

    const result = await sendEmail({
      to: bam.email,
      cc: [ROBIN_EMAIL],
      subject: `Bud Light U - Spending reminder for ${monthLabel}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
          <p style="font-size: 16px; color: #1a1a2e;">Hi ${bam.first_name},</p>
          <p style="font-size: 14px; color: #374151; line-height: 1.6;">
            We noticed your Bud Light purchases for <strong>${monthLabel}</strong> totaled
            <strong>$${spentLabel}</strong>, which is below the $${capLabel} monthly reimbursement allowance.
          </p>
          <p style="font-size: 14px; color: #374151; line-height: 1.6;">
            As a reminder, you're encouraged to use your full $${capLabel}/month allowance on Bud Light products.
            Your reimbursement for this month will match what you spent.
          </p>
          <p style="font-size: 14px; color: #374151; line-height: 1.6;">
            If you have any questions or concerns, please reach out to your program manager.
          </p>
          <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">Bud Light U Program</p>
        </div>
      `,
      text: `Hi ${bam.first_name},\n\nYour Bud Light purchases for ${monthLabel} totaled $${spentLabel}, below the $${capLabel} monthly allowance. Please try to use your full allowance. Your reimbursement will match what you spent.\n\nIf you have questions, reach out to your program manager.\n\nBud Light U Program`
    })

    let recorded = false
    let recordError: string | undefined
    if (result.sent) {
      // P0-H: if this write fails the email went out but sent_at stays null, so the
      // next click would send a duplicate. Say so instead of returning a bare ok.
      const { data: upd, error: updErr } = await admin.from('bam_warnings')
        // sent_by is an audit field, so prefer the verified session address over
        // the client-supplied admin_email (which anyone could have set).
        .update({ sent_at: new Date().toISOString(), sent_by: auth.email ?? admin_email ?? 'system' })
        .eq('id', warning.id)
        .select('id, sent_at')
      if (updErr) recordError = updErr.message
      else if (!upd || upd.length !== 1 || !upd[0].sent_at) recordError = `sent_at write affected ${upd?.length ?? 0} rows`
      else recorded = true
    }

    return NextResponse.json({
      ok: result.sent && recorded,
      sent: result.sent,
      recorded,
      provider: result.provider,
      error: result.error ?? (recordError ? `email sent but could not be recorded: ${recordError}` : undefined),
    }, { status: result.sent ? (recorded ? 200 : 500) : 502 })
  }

  return NextResponse.json({ ok: false, message: 'action must be "flag" or "send"' }, { status: 400 })
}
