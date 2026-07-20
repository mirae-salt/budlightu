/**
 * POST /api/admin/receipts/decide  { receipt_id, decision: 'approved'|'rejected', reason: string }
 * Robin/Jenna's touchpoint 1 action. Reason required. Audit-logged automatically via DB trigger.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { receipt_id, decision, reason } = body
  if (!receipt_id || !['approved', 'rejected'].includes(decision) || !reason || reason.length < 3) {
    return NextResponse.json({ ok: false, message: 'receipt_id, decision, and reason (>=3 chars) required' }, { status: 400 })
  }

  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: user } = await supa.auth.getUser()
  if (!user.user) return NextResponse.json({ ok: false }, { status: 401 })
  const role = (user.user.user_metadata as { role?: string }).role
  if (!role || !['program_admin', 'super_admin'].includes(role)) {
    return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })
  }

  const admin = serviceClient()
  const { error } = await admin.from('receipts').update({
    status: decision,
    decided_by: user.user.id,
    decided_at: new Date().toISOString(),
    decision_reason: reason
  }).eq('id', receipt_id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
