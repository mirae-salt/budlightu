/**
 * POST /api/admin/send-bam-copy  { invoice_id } or { invoice_ids: string[] }
 *
 * Sends a copy of the invoice to the BAM themselves (record-keeping — P0-4).
 *
 * HARD BLOCK: bams.email_verified_at must be set (i.e. the student has
 * logged in via OTP at least once) before we will email anything containing
 * banking-adjacent invoice details to their address. This prevents a typo'd
 * onboarding email from silently receiving someone else's invoice.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../lib/send-email'
import { invoicePdfFilename } from '../../../../lib/invoice-numbering'

interface SendOutcome {
  invoice_id: string
  ok: boolean
  blocked?: boolean
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
  const isDev = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
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
    outcomes.push(await sendOneBamCopy(admin, invoiceId))
  }

  const sent = outcomes.filter(o => o.ok).length
  const blocked = outcomes.filter(o => o.blocked).length
  const failed = outcomes.length - sent - blocked

  return NextResponse.json({ ok: failed === 0, sent, blocked, failed, results: outcomes })
}

async function sendOneBamCopy(admin: ReturnType<typeof serviceClient>, invoiceId: string): Promise<SendOutcome> {
  const { data: inv, error: invErr } = await admin
    .from('invoices')
    .select('*, bams(first_name, last_name, email, email_verified_at), cohorts(bam_copy_mode)')
    .eq('id', invoiceId)
    .single()

  if (invErr || !inv) {
    return { invoice_id: invoiceId, ok: false, error: `invoice not found: ${invErr?.message ?? 'unknown'}` }
  }

  const bam = (inv as { bams?: { first_name: string; last_name: string; email: string; email_verified_at: string | null } }).bams
  const cohort = (inv as { cohorts?: { bam_copy_mode: string } }).cohorts
  if (!bam) return { invoice_id: invoiceId, ok: false, error: 'bam not found for invoice' }

  // --- P0-4 HARD BLOCK ---
  if (!bam.email_verified_at) {
    return {
      invoice_id: invoiceId,
      ok: false,
      blocked: true,
      error: 'BAM email not verified — bams.email_verified_at is NULL. Student must log in via OTP at least once before receiving invoice copies.'
    }
  }

  if (cohort?.bam_copy_mode === 'off') {
    return { invoice_id: invoiceId, ok: false, blocked: true, error: 'cohort.bam_copy_mode=off — BAM copies disabled for this cohort' }
  }

  // duplicate-send guard (P0-5a)
  const { data: existingSend } = await admin
    .from('invoice_sends')
    .select('id')
    .eq('invoice_id', invoiceId)
    .eq('target', 'bam')
    .maybeSingle()
  if (existingSend) {
    return { invoice_id: invoiceId, ok: false, error: 'already sent BAM copy for this invoice (invoice_sends dupe guard)' }
  }

  const period = new Date(inv.period)
  const monthLong = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const filename = invoicePdfFilename(bam.first_name, bam.last_name, period, inv.invoice_number)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://budlightu.com'
  const portalUrl = `${appUrl}/portal/dashboard`

  let attachments: Array<{ filename: string; content: Buffer }> | undefined
  if (inv.pdf_key) {
    const { data: pdfFile } = await admin.storage.from('invoices').download(inv.pdf_key)
    if (pdfFile) {
      attachments = [{ filename, content: Buffer.from(await pdfFile.arrayBuffer()) }]
    }
  }

  const subject = `Your ${monthLong} invoice is ready — Bud Light U`
  const html = bamCopyEmailHtml(bam.first_name, monthLong, inv.invoice_number, portalUrl, Boolean(attachments))

  const result = await sendEmail({
    to: bam.email,
    subject,
    html,
    attachments
  })

  await admin.from('invoice_sends').insert({
    invoice_id: invoiceId,
    target: 'bam',
    mode: result.sent ? 'live' : 'dryrun',
    address: bam.email,
    message_id: result.messageId ?? null,
    attempts: 1,
    last_error: result.error ?? null,
    sent_at: result.sent ? new Date().toISOString() : null
  })

  return { invoice_id: invoiceId, ok: result.sent, provider: result.provider, error: result.error }
}

function bamCopyEmailHtml(firstName: string, month: string, invoiceNumber: string, portalUrl: string, attached: boolean): string {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <h2 style="color: #001a3e; margin: 0;">Bud Light U</h2>
      <p style="color: #6b7280; font-size: 13px; margin: 4px 0 0;">Campus Ambassador Program</p>
    </div>

    <p style="font-size: 16px; color: #1a1a1a;">Hi ${firstName},</p>

    <p style="font-size: 15px; color: #333; line-height: 1.6;">
      Your ${month} invoice (${invoiceNumber}) has been submitted to Salt AP for payment on
      net-15 terms via direct deposit. ${attached ? 'A copy is attached for your records.' : ''}
    </p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${portalUrl}"
         style="background: #0073cf; color: #ffffff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
        Log in to your portal
      </a>
    </div>

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      You can view and download your invoice any time from your portal. Questions?
      Reach out to your program manager or use the support form in your portal.
    </p>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;" />
    <p style="font-size: 11px; color: #9ca3af; text-align: center;">
      Bud Light U · Campus Ambassador Program · Powered by Salt XC
    </p>
  </div>`
}
