import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
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

  const { bam_id, cohort_id } = await req.json()
  if (!bam_id || !cohort_id) return NextResponse.json({ ok: false, message: 'bam_id and cohort_id required' }, { status: 400 })

  const admin = serviceClient()
  const { error } = await admin.from('bams').update({ cohort_id }).eq('id', bam_id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const userId = await requireAdmin()
  if (!userId) return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })

  const { bam_id } = await req.json()
  if (!bam_id) return NextResponse.json({ ok: false, message: 'bam_id required' }, { status: 400 })

  const admin = serviceClient()
  const { error } = await admin.from('bams').update({ cohort_id: null }).eq('id', bam_id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
