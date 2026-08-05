/**
 * CRUD /api/admin/cohorts
 * POST   — create a new cohort
 * PATCH  — update cohort settings (send_mode, bam_copy_mode, program_label, po_number)
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

async function requireAdmin() {
  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: user } = await supa.auth.getUser()
  if (process.env.NODE_ENV === 'development') return user.user?.id ?? '00000000-0000-0000-0000-000000000000'
  if (!user.user) return null
  const role = (user.user.user_metadata as { role?: string }).role
  if (!role || !['program_admin', 'super_admin'].includes(role)) return null
  return user.user.id
}

export async function POST(req: NextRequest) {
  const userId = await requireAdmin()
  if (!userId) return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })

  const body = await req.json()
  const { name, program_label, po_number, start_date, end_date, reimbursement_max } = body

  if (!name?.trim() || !start_date || !end_date) {
    return NextResponse.json({ ok: false, message: 'name, start_date, end_date required' }, { status: 400 })
  }

  const admin = serviceClient()
  const { data, error } = await admin.from('cohorts').insert({
    name: name.trim(),
    program_label: program_label || name.trim(),
    po_number: po_number || null,
    start_date,
    end_date,
    send_mode: 'dryrun',
    bam_copy_mode: 'draft',
    reimbursement_max: reimbursement_max ?? 150
  }).select().single()

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, data })
}

export async function DELETE(req: NextRequest) {
  const userId = await requireAdmin()
  if (!userId) return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })

  const { id } = await req.json()
  if (!id) return NextResponse.json({ ok: false, message: 'id required' }, { status: 400 })

  const admin = serviceClient()

  const { count } = await admin.from('bams').select('id', { count: 'exact', head: true }).eq('cohort_id', id)
  if (count && count > 0) {
    return NextResponse.json({ ok: false, message: `Cannot delete: ${count} BAMs still assigned` }, { status: 409 })
  }

  const { error } = await admin.from('cohorts').delete().eq('id', id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest) {
  const userId = await requireAdmin()
  if (!userId) return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })

  const body = await req.json()
  const { id, ...patch } = body
  if (!id) return NextResponse.json({ ok: false, message: 'id required' }, { status: 400 })

  const allowed = ['name', 'program_label', 'po_number', 'send_mode', 'bam_copy_mode', 'start_date', 'end_date', 'reimbursement_max']
  const cleanPatch: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in patch) cleanPatch[key] = patch[key]
  }

  if (Object.keys(cleanPatch).length === 0) {
    return NextResponse.json({ ok: false, message: 'no updatable fields provided' }, { status: 400 })
  }

  const admin = serviceClient()
  const { data, error } = await admin.from('cohorts').update(cleanPatch).eq('id', id).select().single()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, data })
}
