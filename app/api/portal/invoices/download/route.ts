import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { renderInvoicePdfToBuffer, buildSamplePayload } from '../../../../../lib/render-pdf'
import type { InvoicePayload } from '../../../../../lib/invoice-payload'

const DEMO_INVOICES: Record<string, { number: string; bam: string; amount: string; period: string }> = {
  'demo-1': { number: 'INV-AT1', bam: 'Alex Thompson', amount: '$368.75', period: 'September 2026' },
  'demo-2': { number: 'INV-AT2', bam: 'Alex Thompson', amount: '$368.75', period: 'October 2026' },
}

export async function GET(req: NextRequest) {
  const invoiceId = new URL(req.url).searchParams.get('id')
  if (!invoiceId) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const isDev = process.env.NODE_ENV === 'development'

  if (isDev && DEMO_INVOICES[invoiceId]) {
    const payload = buildSamplePayload(DEMO_INVOICES[invoiceId])
    const buffer = await renderInvoicePdfToBuffer(payload)
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${DEMO_INVOICES[invoiceId].number}.pdf"`
      }
    })
  }

  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: userRes } = await supa.auth.getUser()

  if (!isDev && !userRes.user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const admin = serviceClient()

  let bamId: string | null = null
  if (isDev && !userRes.user) {
    bamId = '00000000-0000-0000-0000-000000000000'
  } else if (userRes.user) {
    const { data: bamRow } = await admin.from('bams')
      .select('id').eq('auth_user_id', userRes.user.id).single()
    bamId = bamRow?.id ?? null
  }

  if (!bamId) return NextResponse.json({ error: 'No BAM account found' }, { status: 403 })
  const { data: inv } = await admin.from('invoices')
    .select('id, invoice_number, bam_id, payload_json')
    .eq('id', invoiceId).single()
  if (!inv) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  if (!isDev && inv.bam_id !== bamId) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  if (!inv.payload_json || !('invoiceNumber' in (inv.payload_json as object))) {
    return NextResponse.json({ error: 'Invoice payload not available' }, { status: 404 })
  }

  const payload = inv.payload_json as unknown as InvoicePayload
  const buffer = await renderInvoicePdfToBuffer(payload)
  const uint8 = new Uint8Array(buffer)

  return new NextResponse(uint8, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${inv.invoice_number}.pdf"`
    }
  })
}
