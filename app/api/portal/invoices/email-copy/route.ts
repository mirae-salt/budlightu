/**
 * POST /api/portal/invoices/email-copy  { invoice_id }
 * BAM self-service: emails a copy of their invoice PDF to their own email.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { renderInvoicePdfToBuffer } from '../../../../../lib/render-pdf'
import { sendEmail } from '../../../../../lib/send-email'
import type { InvoicePayload } from '../../../../../lib/invoice-payload'

export async function POST(req: NextRequest) {
  const { invoice_id } = await req.json()
  if (!invoice_id) return NextResponse.json({ ok: false, error: 'invoice_id required' }, { status: 400 })

  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: userRes } = await supa.auth.getUser()
  const isDev = process.env.NODE_ENV === 'development'

  const admin = serviceClient()

  const { data: inv } = await admin.from('invoices')
    .select('id, invoice_number, bam_id, payload_json, period')
    .eq('id', invoice_id).single()
  if (!inv) return NextResponse.json({ ok: false, error: 'Invoice not found' }, { status: 404 })

  // Ownership check
  if (!isDev && userRes.user) {
    const { data: bam } = await admin.from('bams').select('id').eq('auth_user_id', userRes.user.id).single()
    if (!bam || bam.id !== inv.bam_id) {
      return NextResponse.json({ ok: false, error: 'Access denied' }, { status: 403 })
    }
  }

  const { data: bam } = await admin.from('bams')
    .select('first_name, last_name, email')
    .eq('id', inv.bam_id).single()
  if (!bam?.email) return NextResponse.json({ ok: false, error: 'BAM email not found' }, { status: 404 })

  if (!inv.payload_json) return NextResponse.json({ ok: false, error: 'Invoice not generated yet' }, { status: 400 })

  const payload = inv.payload_json as unknown as InvoicePayload
  const buffer = await renderInvoicePdfToBuffer(payload)

  const period = new Date(inv.period + 'T00:00:00')
  const monthLabel = period.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  const result = await sendEmail({
    to: bam.email,
    subject: `Your Bud Light U Invoice — ${monthLabel}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <p style="font-size: 16px; color: #1a1a2e;">Hi ${bam.first_name},</p>
        <p style="font-size: 14px; color: #374151; line-height: 1.6;">
          Here is a copy of your invoice <strong>${inv.invoice_number}</strong> for <strong>${monthLabel}</strong>.
          The PDF is attached below.
        </p>
        <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">
          — Bud Light U
        </p>
      </div>
    `,
    attachments: [{ filename: `${inv.invoice_number}.pdf`, content: Buffer.from(buffer) }]
  })

  return NextResponse.json({ ok: result.sent, error: result.error })
}
