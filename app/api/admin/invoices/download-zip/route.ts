/**
 * POST /api/admin/invoices/download-zip  { invoice_ids?: string[] }
 *
 * P0-A: this route had NO authorization check at all. It runs on the service-role
 * key and every PDF it builds contains a BAM's bank name, institution number,
 * transit number and account number, so an anonymous POST returned all 58 BAMs'
 * banking details in one archive. It is admin-only now.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import JSZip from 'jszip'
import { renderInvoicePdfToBuffer, buildSamplePayload } from '@/lib/render-pdf'
import type { InvoicePayload } from '@/lib/invoice-payload'
import { requireAdmin, denied } from '@/lib/admin-auth'

export async function POST(req: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const { invoice_ids } = (await req.json()) as { invoice_ids?: string[] }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  let invoices: Array<{
    id: string
    invoice_number: string
    period: string
    payload_json: unknown
    bams: { first_name: string; last_name: string } | null
  }>

  if (invoice_ids && invoice_ids.length > 0) {
    const { data } = await admin.from('invoices')
      .select('id, invoice_number, period, payload_json, bams(first_name, last_name)')
      .in('id', invoice_ids)
    invoices = (data ?? []) as unknown as typeof invoices
  } else {
    const { data } = await admin.from('invoices')
      .select('id, invoice_number, period, payload_json, bams(first_name, last_name)')
      .in('status', ['draft', 'sent'])
      .order('invoice_number')
    invoices = (data ?? []) as unknown as typeof invoices
  }

  if (invoices.length === 0) {
    return NextResponse.json({ error: 'No invoices found' }, { status: 404 })
  }

  const zip = new JSZip()

  for (const inv of invoices) {
    let payload: InvoicePayload

    if (inv.payload_json && typeof inv.payload_json === 'object' && 'invoiceNumber' in (inv.payload_json as object)) {
      payload = inv.payload_json as unknown as InvoicePayload
    } else {
      const bam = inv.bams as { first_name: string; last_name: string } | null
      payload = buildSamplePayload({
        number: inv.invoice_number,
        bam: bam ? `${bam.first_name} ${bam.last_name}` : 'Unknown',
        amount: '$368.75',
        period: inv.period
      })
    }

    const buffer = await renderInvoicePdfToBuffer(payload)
    const bamName = inv.bams ? `${inv.bams.first_name} ${inv.bams.last_name}` : 'Unknown'
    const periodDate = new Date(inv.period)
    const monthYear = periodDate.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    const filename = `${bamName} - ${monthYear} - ${inv.invoice_number}.pdf`

    zip.file(filename, buffer)
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
  const now = new Date().toISOString().slice(0, 10)

  return new NextResponse(new Uint8Array(zipBuffer), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="BLU-Invoices-${now}.zip"`
    }
  })
}
