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
  const { cohort_id, period } = await req.json()
  if (!cohort_id || !period) return NextResponse.json({ ok: false, message: 'cohort_id + period required' }, { status: 400 })

  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: user } = await supa.auth.getUser()
  const isDev = process.env.NODE_ENV === 'development'
  if (!isDev) {
    if (!user.user) return NextResponse.json({ ok: false }, { status: 401 })
    const role = (user.user.user_metadata as { role?: string }).role
    if (!role || !['program_admin', 'super_admin'].includes(role)) {
      return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })
    }
  }

  const admin = serviceClient()
  const { data: cohort } = await admin.from('cohorts').select('*').eq('id', cohort_id).single()
  if (!cohort) return NextResponse.json({ ok: false, message: 'cohort not found' }, { status: 404 })
  if (!cohort.po_number) {
    return NextResponse.json({ ok: false, message: 'HARD BLOCK · cohort.po_number not set' }, { status: 412 })
  }

  const { data: invoices } = await admin.from('invoices')
    .select('id')
    .eq('cohort_id', cohort_id).eq('period', period).eq('status', 'draft')
  if (!invoices?.length) return NextResponse.json({ ok: true, processed: 0 })

  const results: Array<{ id: string; ap: any; sharepoint: any; bam: any }> = []
  for (const inv of invoices) {
    const ap         = await sendAp({ invoice_id: inv.id, mode: cohort.send_mode })
    const sharepoint = await archive({ invoice_id: inv.id })
    const bam        = cohort.bam_copy_mode === 'off'
      ? { ok: true, skipped: true }
      : await sendBamCopy({ invoice_id: inv.id, mode: cohort.bam_copy_mode })
    results.push({ id: inv.id, ap, sharepoint, bam })
  }

  return NextResponse.json({ ok: true, processed: results.length, results })
}
