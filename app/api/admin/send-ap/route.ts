/**
 * POST /api/admin/send-ap  { invoice_id } or { invoice_ids: string[] }
 *
 * Sends invoice(s) to Salt AP (accounts.payable@ilovesalt.com), CC Jenna/Robin.
 * Provider is picked automatically by lib/send-email.ts (Resend by default,
 * MS Graph once creds land). 1 PDF per email — AP does not accept batching.
 *
 * NOTE: PDF attachment is wired in once PDF rendering ships; for now the
 * invoice details are included in the email body so AP has everything it
 * needs to review, and the send is still recorded for idempotency.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../lib/send-email'
import { apEmailSubject, apEmailBody, invoicePdfFilename } from '../../../../lib/invoice-numbering'

const AP_TO = process.env.AP_EMAIL || 'accounts.payable@ilovesalt.com'
const AP_CC = (process.env.AP_CC_EMAILS || 'Jenna.Greenspoon@ilovesalt.com,robin.graham@ilovesalt.com')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

interface SendOutcome {
  invoice_id: string
  ok: boolean
  provider?: string
  error?: string
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const invoiceIds: string[] = body.invoice_ids ?? (body.invoice_id ? [body.invoice_id] : [])
  if (!invoiceIds.length) {
    return NextResponse.json({ ok: false, message: 'invoice_id or invoice_ids required' }, { status: 400 })
  }

  // --- auth: admin only, skip in dev ---
  const isDev = process.env.NODE_ENV === 'development'
  if (!isDev) {
    const cookieStore = await cookies()
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const supa = createServerClient(url, anon, {
      cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
    })
    const { data: user } = await supa.auth.getUser()
    if (!user.user) return NextResponse.json({ ok: false }, { status: 401 })
    const role = (user.user.user_metadata as { role?: string }).role
    if (!role || !['program_admin', 'super_admin'].includes(role)) {
      return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })
    }
  }

  const admin = serviceClient()
  const outcomes: SendOutcome[] = []

  for (const invoiceId of invoiceIds) {
    outcomes.push(await sendOneInvoiceToAp(admin, invoiceId))
  }

  const sent = outcomes.filter(o => o.ok).length
  const failed = outcomes.length - sent

  return NextResponse.json({ ok: failed === 0, sent, failed, results: outcomes })
}

async function sendOneInvoiceToAp(admin: ReturnType<typeof serviceClient>, invoiceId: string): Promise<SendOutcome> {
  const { data: inv, error: invErr } = await admin
    .from('invoices')
    .select('*, bams(first_name, last_name, email), cohorts(po_number, program_label)')
    .eq('id', invoiceId)
    .single()

  if (invErr || !inv) {
    return { invoice_id: invoiceId, ok: false, error: `invoice not found: ${invErr?.message ?? 'unknown'}` }
  }

  const bam = (inv as { bams?: { first_name: string; last_name: string; email: string } }).bams
  const cohort = (inv as { cohorts?: { po_number: string | null; program_label: string } }).cohorts
  if (!bam) return { invoice_id: invoiceId, ok: false, error: 'bam not found for invoice' }
  if (!cohort) return { invoice_id: invoiceId, ok: false, error: 'cohort not found for invoice' }
  if (!cohort.po_number) {
    // ⚠️ PO number unconfirmed (250437/260814/260351) — never guess, hard block instead.
    return { invoice_id: invoiceId, ok: false, error: 'cohort.po_number missing — HARD BLOCK, confirm PO before sending' }
  }

  // duplicate-send guard (P0-5a): skip if already recorded as sent to AP
  const { data: existingSend } = await admin
    .from('invoice_sends')
    .select('id')
    .eq('invoice_id', invoiceId)
    .eq('target', 'ap')
    .maybeSingle()
  if (existingSend) {
    return { invoice_id: invoiceId, ok: false, error: 'already sent to AP for this invoice (invoice_sends dupe guard)' }
  }

  const period = new Date(inv.period)
  const monthLong = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const subject = apEmailSubject(bam.first_name, bam.last_name, period, inv.invoice_number)
  const bodyText = apEmailBody(monthLong, cohort.program_label, cohort.po_number)
  const filename = invoicePdfFilename(bam.first_name, bam.last_name, period, inv.invoice_number)

  // Best-effort PDF attachment if one has already been rendered to storage.
  let attachments: Array<{ filename: string; content: Buffer }> | undefined
  if (inv.pdf_key) {
    const { data: pdfFile } = await admin.storage.from('invoices').download(inv.pdf_key)
    if (pdfFile) {
      attachments = [{ filename, content: Buffer.from(await pdfFile.arrayBuffer()) }]
    }
  }

  const html = textToEmailHtml(bodyText, {
    invoiceNumber: inv.invoice_number,
    bamName: `${bam.first_name} ${bam.last_name}`,
    month: monthLong,
    poNumber: cohort.po_number,
    programLabel: cohort.program_label,
    attached: Boolean(attachments)
  })

  const result = await sendEmail({
    to: AP_TO,
    cc: AP_CC,
    subject,
    html,
    text: bodyText,
    attachments
  })

  // record send attempt (idempotent via invoice_sends UNIQUE(invoice_id,target,mode))
  await admin.from('invoice_sends').insert({
    invoice_id: invoiceId,
    target: 'ap',
    mode: result.sent ? 'live' : 'dryrun',
    address: AP_TO,
    message_id: result.messageId ?? null,
    attempts: 1,
    last_error: result.error ?? null,
    sent_at: result.sent ? new Date().toISOString() : null
  })

  if (result.sent) {
    await admin.from('invoices').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', invoiceId)
  }

  return { invoice_id: invoiceId, ok: result.sent, provider: result.provider, error: result.error }
}

function textToEmailHtml(
  bodyText: string,
  meta: { invoiceNumber: string; bamName: string; month: string; poNumber: string; programLabel: string; attached: boolean }
): string {
  const paragraphs = bodyText
    .split('\n')
    .map(line => (line.trim() ? `<p style="margin: 0 0 8px; font-size: 14px; color: #1a1a1a;">${line}</p>` : ''))
    .join('')
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
    ${paragraphs}
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0 12px;" />
    <table style="font-size: 12px; color: #6b7280; border-collapse: collapse;">
      <tr><td style="padding: 2px 8px 2px 0;">Invoice #</td><td>${meta.invoiceNumber}</td></tr>
      <tr><td style="padding: 2px 8px 2px 0;">BAM</td><td>${meta.bamName}</td></tr>
      <tr><td style="padding: 2px 8px 2px 0;">Period</td><td>${meta.month}</td></tr>
      <tr><td style="padding: 2px 8px 2px 0;">Program</td><td>${meta.programLabel}</td></tr>
      <tr><td style="padding: 2px 8px 2px 0;">PO#</td><td>${meta.poNumber}</td></tr>
      <tr><td style="padding: 2px 8px 2px 0;">PDF attached</td><td>${meta.attached ? 'Yes' : 'Not yet rendered — details above'}</td></tr>
    </table>
  </div>`
}
