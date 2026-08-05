import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'

export async function POST(req: NextRequest) {
  const { receipt_id } = await req.json()
  if (!receipt_id) return NextResponse.json({ ok: false, message: 'receipt_id required' }, { status: 400 })

  const admin = serviceClient()
  const { data: receipt } = await admin.from('receipts')
    .select('id, storage_key, status')
    .eq('id', receipt_id).single()
  if (!receipt) return NextResponse.json({ ok: false, message: 'receipt not found' }, { status: 404 })
  if (!receipt.storage_key) return NextResponse.json({ ok: false, message: 'no storage_key — cannot retry' }, { status: 400 })

  await admin.from('receipts').update({ status: 'pending', ocr_attempts: 0 }).eq('id', receipt_id)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3000}`
  fetch(`${appUrl}/api/receipts/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receipt_id: receipt.id, storage_key: receipt.storage_key })
  }).catch(() => {})

  return NextResponse.json({ ok: true, message: 'OCR retry queued' })
}
