/**
 * Server-side admin data fetcher — bypasses RLS using service role key.
 * Returns data for all admin pages so client doesn't need to query Supabase directly.
 *
 * GET /api/admin/data?table=bams|receipts|invoices|cohorts|unmatched|audit|dashboard
 */
import { NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'

function countConsecutiveLow(monthly: Record<string, number>, threshold: number): number {
  const months = Object.keys(monthly).sort()
  let maxStreak = 0, streak = 0
  for (const m of months) {
    if (monthly[m] < threshold) { streak++; maxStreak = Math.max(maxStreak, streak) }
    else streak = 0
  }
  return maxStreak
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const table = url.searchParams.get('table')

  let admin
  try {
    admin = serviceClient()
  } catch {
    return NextResponse.json({ data: null, error: 'Service role key not configured' }, { status: 500 })
  }

  switch (table) {
    case 'bams': {
      const { data, error } = await admin.from('bams')
        .select('id, first_name, last_name, email, status, bank_name, initials_resolved, invite_token_hash, school_id, cohort_id, cohorts(name)')
      return NextResponse.json({ data, error: error?.message ?? null })
    }

    case 'receipts': {
      const { data, error } = await admin.from('receipts')
        .select('id, status, uploaded_at, bud_light_total_incl_tax, ambiguous_flags, decided_at, decision_reason, storage_key, storage_mime, ocr_json, bams(first_name, last_name)')
        .order('uploaded_at', { ascending: false })
      return NextResponse.json({ data, error: error?.message ?? null })
    }

    case 'invoices': {
      const { data: invoices, error } = await admin.from('invoices')
        .select('id, invoice_number, period, status, cohort_id, bam_id, payload_json, bams(first_name, last_name)')
        .in('status', ['draft', 'sent'])
        .order('created_at', { ascending: false })
      if (error || !invoices) return NextResponse.json({ data: null, error: error?.message ?? null })

      const bamIds = [...new Set((invoices as { bam_id: string }[]).map(i => i.bam_id))]
      const periods = [...new Set((invoices as { period: string }[]).map(i => i.period))]

      let receiptMap: Record<string, { status: string; total: number | null }> = {}
      if (bamIds.length > 0 && periods.length > 0) {
        const { data: receipts } = await admin.from('receipts')
          .select('bam_id, period, status, bud_light_total_incl_tax')
          .in('bam_id', bamIds)
          .in('period', periods)
        if (receipts) {
          for (const r of receipts as { bam_id: string; period: string; status: string; bud_light_total_incl_tax: number | null }[]) {
            receiptMap[`${r.bam_id}_${r.period}`] = { status: r.status, total: r.bud_light_total_incl_tax }
          }
        }
      }

      const enriched = (invoices as { bam_id: string; period: string; [k: string]: unknown }[]).map(inv => {
        const receipt = receiptMap[`${inv.bam_id}_${inv.period}`]
        return { ...inv, receipt_status: receipt?.status ?? null, receipt_total: receipt?.total ?? null }
      })
      return NextResponse.json({ data: enriched, error: null })
    }

    case 'cohorts': {
      const { data: cohorts, error } = await admin.from('cohorts')
        .select('id, name, program_label, po_number, start_date, end_date, send_mode, bam_copy_mode')
      if (error || !cohorts) return NextResponse.json({ data: null, error: error?.message ?? null })

      const withCounts = await Promise.all(cohorts.map(async (c: Record<string, unknown>) => {
        const { count } = await admin.from('bams').select('id', { count: 'exact', head: true }).eq('cohort_id', c.id)
        return { ...c, bam_count: count ?? 0 }
      }))
      return NextResponse.json({ data: withCounts, error: null })
    }

    case 'unmatched': {
      const { data, error } = await admin.from('onboarding_submissions')
        .select('id, submitted_email, submitted_at, flag_reason, form_json_meta')
        .eq('status', 'unmatched')
        .order('submitted_at', { ascending: false })
      return NextResponse.json({ data, error: error?.message ?? null })
    }

    case 'audit': {
      const { data, error } = await admin.from('audit_log')
        .select('ts, actor_role, entity, entity_id, action, after_json')
        .order('ts', { ascending: false })
        .limit(200)
      return NextResponse.json({ data, error: error?.message ?? null })
    }

    case 'dashboard': {
      const period = url.searchParams.get('period') ?? new Date().toISOString().slice(0, 7) + '-01'
      const [activeBams, pendingBams, receiptsSubmitted, reviewQueue, invoicesSent] = await Promise.all([
        admin.from('bams').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        admin.from('bams').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        admin.from('receipts').select('id', { count: 'exact', head: true }).eq('period', period),
        admin.from('receipts').select('id', { count: 'exact', head: true }).in('status', ['review', 'ocr_failed']),
        admin.from('invoices').select('id', { count: 'exact', head: true }).eq('status', 'sent')
      ])

      // Monthly chart data: last 12 months of invoice counts + reimbursement totals
      const { data: monthlyInvoices } = await admin.from('invoices')
        .select('period, status')
        .in('status', ['sent', 'paid', 'draft'])
        .order('period', { ascending: true })
      const { data: monthlyLedger } = await admin.from('reimbursement_ledger')
        .select('period, spent_cad')
        .order('period', { ascending: true })

      const invoicesByMonth: Record<string, number> = {}
      const reimbByMonth: Record<string, number> = {}
      for (const inv of (monthlyInvoices ?? []) as { period: string }[]) {
        const m = inv.period.slice(0, 7)
        invoicesByMonth[m] = (invoicesByMonth[m] ?? 0) + 1
      }
      for (const entry of (monthlyLedger ?? []) as { period: string; spent_cad: number }[]) {
        const m = entry.period.slice(0, 7)
        reimbByMonth[m] = (reimbByMonth[m] ?? 0) + (entry.spent_cad ?? 0)
      }

      return NextResponse.json({
        data: {
          activeBams: activeBams.count ?? 0,
          pendingBams: pendingBams.count ?? 0,
          receiptsSubmitted: receiptsSubmitted.count ?? 0,
          reviewQueue: reviewQueue.count ?? 0,
          invoicesSent: invoicesSent.count ?? 0,
          invoicesByMonth,
          reimbByMonth
        },
        error: null
      })
    }

    case 'bam_spending': {
      const { data: bams } = await admin.from('bams')
        .select('id, cohort_id, first_name, last_name, email, status, cohorts(name, start_date, end_date)')
        .eq('status', 'active')

      if (!bams || bams.length === 0) return NextResponse.json({ data: [], error: null })

      const bamIds = (bams as { id: string }[]).map(b => b.id)
      const { data: receipts } = await admin.from('receipts')
        .select('bam_id, period, bud_light_total_incl_tax, status')
        .in('bam_id', bamIds)
        .in('status', ['auto_pass', 'approved'])

      const spendMap: Record<string, Record<string, number>> = {}
      for (const r of (receipts ?? []) as { bam_id: string; period: string; bud_light_total_incl_tax: number | null }[]) {
        const month = r.period.slice(0, 7)
        if (!spendMap[r.bam_id]) spendMap[r.bam_id] = {}
        spendMap[r.bam_id][month] = (spendMap[r.bam_id][month] ?? 0) + (r.bud_light_total_incl_tax ?? 0)
      }

      const { data: warnings } = await admin.from('bam_warnings')
        .select('bam_id, warning_number, sent_at, period')
        .in('bam_id', bamIds)
      const warningMap: Record<string, { count: number; sent: number; periods: string[] }> = {}
      for (const w of (warnings ?? []) as { bam_id: string; warning_number: number; sent_at: string | null; period: string }[]) {
        if (!warningMap[w.bam_id]) warningMap[w.bam_id] = { count: 0, sent: 0, periods: [] }
        warningMap[w.bam_id].count = Math.max(warningMap[w.bam_id].count, w.warning_number)
        if (w.sent_at) warningMap[w.bam_id].sent++
        warningMap[w.bam_id].periods.push(w.period)
      }

      const LOW_THRESHOLD = 130
      const REEVALUATE_THRESHOLD = 2
      const result = (bams as unknown as { id: string; first_name: string; last_name: string; email: string; cohort_id: string; cohorts?: { name: string } | null }[]).map(b => {
        const monthly = spendMap[b.id] ?? {}
        const months = Object.keys(monthly).sort()
        const totalSpent = Object.values(monthly).reduce((a, v) => a + v, 0)
        const avgMonthly = months.length > 0 ? totalSpent / months.length : 0
        const lowMonths = Object.entries(monthly).filter(([, v]) => v < LOW_THRESHOLD).length
        const consecutiveLow = countConsecutiveLow(monthly, LOW_THRESHOLD)
        const warnInfo = warningMap[b.id] ?? { count: 0, sent: 0, periods: [] }
        return {
          bam_id: b.id,
          cohort_id: b.cohort_id,
          name: `${b.first_name} ${b.last_name}`,
          email: b.email,
          cohort: b.cohorts?.name ?? '—',
          monthly,
          totalSpent: Math.round(totalSpent * 100) / 100,
          avgMonthly: Math.round(avgMonthly * 100) / 100,
          lowMonths,
          consecutiveLow,
          isLowPerformer: consecutiveLow >= 3,
          warningCount: warnInfo.count,
          warningsSent: warnInfo.sent,
          warningPeriods: warnInfo.periods,
          needsReevaluation: warnInfo.count >= REEVALUATE_THRESHOLD,
        }
      })

      return NextResponse.json({ data: result, error: null })
    }

    default:
      return NextResponse.json({ error: 'Invalid table parameter' }, { status: 400 })
  }
}
