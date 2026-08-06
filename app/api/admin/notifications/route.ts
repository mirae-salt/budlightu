import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { action, ids } = body
  const admin = serviceClient()

  if (action === 'mark_read' && Array.isArray(ids) && ids.length > 0) {
    await admin.from('admin_notifications').update({ read: true }).in('id', ids)
    return NextResponse.json({ ok: true })
  }

  if (action === 'mark_all_read') {
    await admin.from('admin_notifications').update({ read: true }).eq('read', false)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: false, message: 'invalid action' }, { status: 400 })
}
