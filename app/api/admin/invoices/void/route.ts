/**
 * POST /api/admin/invoices/void  { invoice_id, reason }
 * Voids a SENT invoice. DB trigger auto-creates an AP cancellation draft
 * (see supabase/migrations/0007_void_ap_cancellation.sql). The program admin
 * sends it manually from admin/invoices/[id]/cancellation.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function POST(req: NextRequest) {
  const { invoice_id, reason } = await req.json()
  if (!invoice_id || !reason || reason.length < 5) {
    return NextResponse.json({ ok: false, message: 'Please provide a void reason (at least 5 characters).' }, { status: 400 })
  }

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
  const { error } = await admin.from('invoices')
    .update({ status: 'void', void_reason: reason })
    .eq('id', invoice_id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, note: 'AP cancellation draft auto-generated; review in /admin/invoices/[id]/cancellation' })
}
