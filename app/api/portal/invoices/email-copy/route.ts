/**
 * POST /api/portal/invoices/email-copy  { invoice_id }
 * BAM self-service: emails a copy of their own invoice PDF to their own address.
 *
 * CRITIC GATE 2026-08-07 F3 — this route used to leak banking PII to anyone.
 *
 * The ownership check was written as:
 *     if (!isDev && userRes.user) { ...compare bams.auth_user_id to inv.bam_id... }
 * With no session at all `userRes.user` is null, so the condition is false, the
 * whole block is SKIPPED, and execution falls through to render and email a PDF
 * containing the BAM's home address, bank name, institution number, transit
 * number and full account number. middleware.ts only matches
 * `path.startsWith('/portal')`, not `/api/portal`, so nothing else gated it.
 * An unauthenticated POST with a guessed invoice id mailed that PDF.
 *
 * It is now `requireBam()` from lib/admin-auth: no session = 401, session that is
 * not a BAM = 403, BAM that does not own this invoice = 403. requireBam() has no
 * dev bypass and resolves the BAM from `bams.auth_user_id` in the database rather
 * than from forgeable JWT metadata (P0-A).
 *
 * Recipient is `bams.email` from the database, never a value from the request.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../../lib/send-email'
import { requireBam, denied } from '../../../../../lib/admin-auth'
import { addressProblem, cleanAddress } from '../../../../../lib/sanitize'
import { ensureInvoicePdf } from '../../../../../lib/invoice-pdf'

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
  }
  const invoice_id = (body as { invoice_id?: unknown })?.invoice_id
  if (typeof invoice_id !== 'string' || !invoice_id) {
    return NextResponse.json({ ok: false, error: 'invoice_id required' }, { status: 400 })
  }

  // F3: authenticate FIRST and fail closed. Nothing below runs without a
  // signed-in, active BAM.
  const bamAuth = await requireBam()
  if (!bamAuth.ok) return denied(bamAuth)

  let admin
  try {
    admin = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 503 })
  }

  const { data: inv, error: invErr } = await admin.from('invoices')
    .select('id, invoice_number, bam_id, payload_json, period, pdf_key')
    .eq('id', invoice_id).maybeSingle()
  if (invErr) return NextResponse.json({ ok: false, error: invErr.message }, { status: 500 })
  if (!inv) return NextResponse.json({ ok: false, error: 'Invoice not found' }, { status: 404 })

  // F3: the ownership check now always runs.
  if (inv.bam_id !== bamAuth.bamId) {
    return NextResponse.json({ ok: false, error: 'Access denied' }, { status: 403 })
  }

  const { data: bam, error: bamErr } = await admin.from('bams')
    .select('first_name, last_name, email')
    .eq('id', inv.bam_id).maybeSingle()
  if (bamErr) return NextResponse.json({ ok: false, error: bamErr.message }, { status: 500 })
  if (!bam?.email) return NextResponse.json({ ok: false, error: 'BAM email not found' }, { status: 404 })

  const recipient = cleanAddress(bam.email)
  const recipientProblem = addressProblem('bam.email', recipient)
  if (recipientProblem) return NextResponse.json({ ok: false, error: recipientProblem }, { status: 400 })

  if (!inv.payload_json) {
    return NextResponse.json({ ok: false, error: 'Invoice not generated yet' }, { status: 400 })
  }

  const period = new Date(inv.period + 'T00:00:00')
  const monthLabel = period.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  // F1: the shared render/archive path, so the student receives the same bytes
  // that were archived rather than an independent re-render.
  // Filename stays `<INV-NUMBER>.pdf`: invoice_number is constrained to
  // `INV-[A-Z]+<seq>` so it is always ASCII (P1-16 class).
  const filename = `${inv.invoice_number}.pdf`
  const pdf = await ensureInvoicePdf(admin, {
    id: inv.id,
    period: inv.period,
    invoice_number: inv.invoice_number,
    pdf_key: inv.pdf_key,
    payload_json: inv.payload_json
  }, filename)
  if (!pdf.ok) return NextResponse.json({ ok: false, error: pdf.error }, { status: 500 })

  const result = await sendEmail({
    to: recipient,
    subject: `Your Bud Light U Invoice - ${monthLabel}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <p style="font-size: 16px; color: #1a1a2e;">Hi ${bam.first_name},</p>
        <p style="font-size: 14px; color: #374151; line-height: 1.6;">
          Here is a copy of your invoice <strong>${inv.invoice_number}</strong> for <strong>${monthLabel}</strong>.
          The PDF is attached below.
        </p>
        <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">
          Bud Light U
        </p>
      </div>
    `,
    attachments: [{ filename, content: Buffer.from(pdf.bytes) }]
  })

  return NextResponse.json({
    ok: result.sent,
    error: result.error,
    ...(pdf.warning ? { warning: pdf.warning } : {})
  })
}
