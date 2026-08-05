/**
 * POST /api/admin/archive-sharepoint  { invoice_id: string }
 * Wrapper around the archiveToSharePoint edge function logic.
 * Uploads the invoice PDF to SharePoint and records the send.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { handler } from '../../../../supabase/functions/archiveToSharePoint/index'

export async function POST(req: NextRequest) {
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

  const body = await req.json()
  const { invoice_id } = body
  if (!invoice_id) return NextResponse.json({ ok: false, message: 'invoice_id required' }, { status: 400 })

  try {
    const result = await handler({ invoice_id })
    if (!result.ok) return NextResponse.json(result, { status: 500 })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'archive failed' }, { status: 500 })
  }
}
