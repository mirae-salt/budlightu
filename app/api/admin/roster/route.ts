import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'

async function getAdminUser() {
  const cookieStore = await cookies()
  const supa = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supa.auth.getUser()
  if (!user) return null
  const role = (user.user_metadata as { role?: string }).role
  if (role !== 'program_admin' && role !== 'super_admin') return null
  return user
}

export async function PATCH(req: NextRequest) {
  const isDev = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
  if (!isDev) {
    const admin = await getAdminUser()
    if (!admin) return NextResponse.json({ ok: false, message: 'Forbidden' }, { status: 403 })
  }

  const { id, ...fields } = await req.json()
  if (!id) return NextResponse.json({ ok: false, message: 'id required' }, { status: 400 })

  const allowed = ['first_name', 'last_name', 'email', 'phone', 'status', 'school_id', 'cohort_id', 'bank_name', 'is_test']
  const update: Record<string, unknown> = {}
  for (const k of allowed) {
    if (k in fields) update[k] = fields[k]
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: false, message: 'No valid fields to update' }, { status: 400 })
  }

  const db = serviceClient()
  const { error } = await db.from('bams').update(update).eq('id', id)
  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
