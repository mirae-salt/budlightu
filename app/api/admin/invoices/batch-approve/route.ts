/**
 * POST /api/admin/invoices/batch-approve  { cohort_id, period }
 * Program admin's touchpoint 2 action. Kicks off render → 3-way send for every draft
 * invoice in the batch. Respects cohort.send_mode + bam_copy_mode; sends only
 * to targets whose mode allows it. Live send requires super-admin toggle
 * elsewhere; this endpoint does not flip send_mode itself.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { handler as sendAp }      from '../../../../../supabase/functions/sendApEmail/index'
import { handler as sendBamCopy } from '../../../../../supabase/functions/sendBamCopy/index'
import { handler as archive }     from '../../../../../supabase/functions/archiveToSharePoint/index'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const invoiceIds: string[] = body.invoice_ids ?? []
  if (!invoiceIds.length) return NextResponse.json({ ok: false, message: 'invoice_ids required' }, { status: 400 })

  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: user } = await supa.auth.getUser()
  const isDev = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
  if (!isDev) {
    if (!user.user) return NextResponse.json({ ok: false }, { status: 401 })
    const role = (user.user.user_metadata as { role?: string }).role
    if (!role || !['program_admin', 'super_admin'].includes(role)) {
      return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })
    }
  }

  const admin = serviceClient()

  const { data: invoices } = await admin.from('invoices')
    .select('id, cohort_id')
    .in('id', invoiceIds)
    .eq('status', 'draft')
  if (!invoices?.length) return NextResponse.json({ ok: true, processed: 0 })

  const cohortIds = [...new Set(invoices.map(i => i.cohort_id))]
  const { data: cohorts } = await admin.from('cohorts').select('*').in('id', cohortIds)
  const cohortMap = new Map((cohorts ?? []).map(c => [c.id, c]))

  for (const c of cohortMap.values()) {
    if (!c.po_number) {
      return NextResponse.json({ ok: false, message: `HARD BLOCK · cohort ${c.name} has no po_number` }, { status: 412 })
    }
  }

  // Atomically mark all draft invoices as approved before external sends.
  // This prevents mixed state if a send fails partway through.
  const approveIds = invoices.map(i => i.id)
  const { error: approveErr } = await admin.from('invoices')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .in('id', approveIds)
  if (approveErr) {
    return NextResponse.json({ ok: false, message: `batch approve failed: ${approveErr.message}` }, { status: 500 })
  }

  // Now attempt external sends — failures are recorded per-invoice, not fatal to the batch
  const results: Array<{ id: string; ap: any; sharepoint: any; bam: any }> = []
  for (const inv of invoices) {
    const cohort = cohortMap.get(inv.cohort_id)
    if (!cohort) continue
    const ap         = await sendAp({ invoice_id: inv.id, mode: cohort.send_mode }).catch((e: Error) => ({ ok: false, error: e.message }))
    const sharepoint = await archive({ invoice_id: inv.id }).catch((e: Error) => ({ ok: false, error: e.message }))
    const bam        = cohort.bam_copy_mode === 'off'
      ? { ok: true, skipped: true }
      : await sendBamCopy({ invoice_id: inv.id, mode: cohort.bam_copy_mode }).catch((e: Error) => ({ ok: false, error: e.message }))
    results.push({ id: inv.id, ap, sharepoint, bam })
  }

  const failures = results.filter(r => !r.ap?.ok || !r.sharepoint?.ok || (!r.bam?.skipped && !r.bam?.ok))
  return NextResponse.json({ ok: failures.length === 0, processed: results.length, failures: failures.length, results })
}
