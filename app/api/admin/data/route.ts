/**
 * Server-side admin data fetcher — bypasses RLS using service role key.
 * Returns data for all admin pages so client doesn't need to query Supabase directly.
 *
 * GET /api/admin/data?table=bams|receipts|invoices|cohorts|unmatched|audit|dashboard
 */
import { NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'

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
        .select('id, status, uploaded_at, bud_light_total_incl_tax, ambiguous_flags, decided_at, decision_reason, bams(first_name, last_name)')
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
      return NextResponse.json({
        data: {
          activeBams: activeBams.count ?? 0,
          pendingBams: pendingBams.count ?? 0,
          receiptsSubmitted: receiptsSubmitted.count ?? 0,
          reviewQueue: reviewQueue.count ?? 0,
          invoicesSent: invoicesSent.count ?? 0
        },
        error: null
      })
    }

    default:
      return NextResponse.json({ error: 'Invalid table parameter' }, { status: 400 })
  }
}
