/**
 * POST /api/admin/archive-sharepoint  { invoice_id: string }
 * Wrapper around the archiveToSharePoint edge function logic.
 * Uploads the invoice PDF to SharePoint and records the send.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import { handler } from '../../../../supabase/functions/archiveToSharePoint/index'

export async function POST(req: NextRequest) {
  // P0-A: role from app_metadata only.
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

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
