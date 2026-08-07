/**
 * POST /api/admin/notifications  { action: 'mark_read' | 'mark_all_read', ids? }
 *
 * P1-9b: this route holds the service role key, so it authorizes itself instead
 * of trusting middleware alone (middleware used to fail open when an env var was
 * missing, P0-A2).
 * P0-H: the update `error` was discarded, so "marked read" could be a lie.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../lib/admin-auth'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }

  const { action, ids } = (body ?? {}) as { action?: unknown; ids?: unknown }

  let admin
  try {
    admin = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  if (action === 'mark_read') {
    const idList = Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
    if (idList.length === 0) {
      return NextResponse.json({ ok: false, message: 'ids required' }, { status: 400 })
    }
    const { data, error } = await admin.from('admin_notifications')
      .update({ read: true })
      .in('id', idList)
      .select('id')
    if (error) {
      return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, updated: data?.length ?? 0 })
  }

  if (action === 'mark_all_read') {
    const { data, error } = await admin.from('admin_notifications')
      .update({ read: true })
      .eq('read', false)
      .select('id')
    if (error) {
      return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, updated: data?.length ?? 0 })
  }

  return NextResponse.json({ ok: false, message: 'invalid action' }, { status: 400 })
}
