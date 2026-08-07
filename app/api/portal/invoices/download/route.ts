/**
 * GET /api/portal/invoices/download?id=<invoice_id>
 * Streams the BAM's own invoice PDF back to the browser.
 *
 * CRITIC GATE 2026-08-07 F3: this route was the better of the two portal invoice
 * routes (it did at least 401 on a missing session) but it still resolved the BAM
 * with an `else if (userRes.user)` chain and then skipped the ownership compare
 * whenever `isDev` was true. Both routes now go through `requireBam()`:
 *   - no session                -> 401
 *   - session that is not a BAM -> 403
 *   - archived BAM              -> 403
 *   - BAM that does not own it  -> 403
 * There is no dev bypass in requireBam(), on purpose: this response body contains
 * a home address, bank name, institution number, transit number and full account
 * number.
 *
 * The dev-only DEMO_INVOICES fixture is retained for local UI work. It renders
 * fabricated data via buildSamplePayload (no database read, no real PII) and is
 * unreachable in a production build because NODE_ENV is 'production' there.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { renderInvoicePdfToBuffer, buildSamplePayload } from '../../../../../lib/render-pdf'
import { requireBam, denied } from '../../../../../lib/admin-auth'
import type { InvoicePayload } from '../../../../../lib/invoice-payload'

const DEMO_INVOICES: Record<string, { number: string; bam: string; amount: string; period: string }> = {
  'demo-1': { number: 'INV-AT1', bam: 'Alex Thompson', amount: '$368.75', period: 'September 2026' },
  'demo-2': { number: 'INV-AT2', bam: 'Alex Thompson', amount: '$368.75', period: 'October 2026' },
}

export async function GET(req: NextRequest) {
  const invoiceId = new URL(req.url).searchParams.get('id')
  if (!invoiceId) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const isDev = process.env.NODE_ENV === 'development'

  // Fabricated sample payload only. No DB read, no real BAM data.
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

  // F3: authenticate FIRST, fail closed, no dev exemption for real invoices.
  const bamAuth = await requireBam()
  if (!bamAuth.ok) return denied(bamAuth)

  let admin
  try {
    admin = serviceClient()
  } catch {
    return NextResponse.json({ error: 'Server is not configured.' }, { status: 503 })
  }

  const { data: inv, error: invErr } = await admin.from('invoices')
    .select('id, invoice_number, bam_id, payload_json')
    .eq('id', invoiceId).maybeSingle()
  if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 })
  if (!inv) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  if (inv.bam_id !== bamAuth.bamId) {
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
      // invoice_number is `INV-[A-Z]+<seq>`, always ASCII (P1-16).
      'Content-Disposition': `inline; filename="${inv.invoice_number}.pdf"`
    }
  })
}
