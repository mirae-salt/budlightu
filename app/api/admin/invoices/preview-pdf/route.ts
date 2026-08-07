/**
 * POST /api/admin/invoices/preview-pdf  { invoice_id } | { row }
 *
 * P0-A: no authorization check existed. The rendered PDF carries the BAM's bank
 * name, institution number, transit number and account number, so any anonymous
 * caller with an invoice id got a BAM's banking details. Admin-only now.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { renderInvoicePdfToBuffer, buildSamplePayload } from '../../../../../lib/render-pdf'
import type { InvoicePayload } from '../../../../../lib/invoice-payload'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'

export async function POST(req: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const body = await req.json()
  const { invoice_id, row } = body as {
    invoice_id?: string
    row?: { number: string; bam: string; amount: string; period: string }
  }

  let payload: InvoicePayload

  if (invoice_id) {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const { data: inv } = await admin.from('invoices')
      .select('invoice_number, payload_json, period, bams(first_name, last_name)')
      .eq('id', invoice_id)
      .single()

    if (inv?.payload_json && typeof inv.payload_json === 'object' && 'invoiceNumber' in (inv.payload_json as object)) {
      payload = inv.payload_json as unknown as InvoicePayload
    } else if (inv) {
      const bam = inv.bams as unknown as { first_name: string; last_name: string } | null
      payload = buildSamplePayload({
        number: inv.invoice_number,
        bam: bam ? `${bam.first_name} ${bam.last_name}` : 'Unknown',
        amount: '$368.75',
        period: inv.period
      })
    } else {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
  } else if (row) {
    payload = buildSamplePayload(row)
  } else {
    return NextResponse.json({ error: 'Provide invoice_id or row data' }, { status: 400 })
  }

  const buffer = await renderInvoicePdfToBuffer(payload)
  const uint8 = new Uint8Array(buffer)

  return new NextResponse(uint8, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${payload.invoiceNumber}.pdf"`
    }
  })
}
