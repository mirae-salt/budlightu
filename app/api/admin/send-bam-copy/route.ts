/**
 * POST /api/admin/send-bam-copy  { invoice_id } or { invoice_ids: string[] }
 *
 * Sends a copy of the invoice to the BAM themselves (record-keeping — P0-4).
 *
 * HARD BLOCK: bams.email_verified_at must be set (i.e. the student has
 * logged in via OTP at least once) before we will email anything containing
 * banking-adjacent invoice details to their address. This prevents a typo'd
 * onboarding email from silently receiving someone else's invoice.
 *
 * AUDIT-2026-08-07 fixes: same duplicate/retry defects as the AP route
 * (P0-B/P0-C) — the guard used .maybeSingle() without .eq('mode') and discarded
 * the error, and failures were recorded as mode:'dryrun' which then blocked
 * every retry permanently. Sends are now claimed via lib/send-guard.ts, and
 * cohort.bam_copy_mode is enforced (P1-1 class: this route ignored it except
 * for 'off').
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../lib/send-email'
import { invoicePdfFilename } from '../../../../lib/invoice-numbering'
import { appBaseUrl } from '../../../../lib/app-url'
import { addressProblem, cleanAddress } from '../../../../lib/sanitize'
import { claimSend, markSendFailed, markSendSucceeded } from '../../../../lib/send-guard'
import { ensureInvoicePdf } from '../../../../lib/invoice-pdf'

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

  // --- auth: admin only (P0-A). Role from app_metadata via lib/admin-auth.
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  // F13: same rule as the AP route. The dev bypass has no real session and is
  // normally pointed at the production Supabase project; it must not be able to
  // mail a student a PDF containing their bank account number.
  if (auth.devBypass) {
    return NextResponse.json({
      ok: false,
      message: 'Dev auth bypass is active. A live BAM copy send is refused. Sign in as a real admin.'
    }, { status: 403 })
  }

  const admin = serviceClient()
  const outcomes: SendOutcome[] = []
  for (const invoiceId of invoiceIds) {
    outcomes.push(await sendOneBamCopy(admin, invoiceId))
  }

  const sent = outcomes.filter(o => o.ok).length
  const blocked = outcomes.filter(o => o.blocked).length
  const failed = outcomes.length - sent - blocked

  return NextResponse.json({ ok: failed === 0 && blocked === 0, sent, blocked, failed, results: outcomes })
}

async function sendOneBamCopy(admin: ReturnType<typeof serviceClient>, invoiceId: string): Promise<SendOutcome> {
  const blocked = (error: string): SendOutcome => ({ invoice_id: invoiceId, ok: false, blocked: true, error })

  const { data: inv, error: invErr } = await admin
    .from('invoices')
    .select('*, bams(first_name, last_name, email, email_verified_at), cohorts(bam_copy_mode)')
    .eq('id', invoiceId)
    .single()

  if (invErr || !inv) {
    return { invoice_id: invoiceId, ok: false, error: `invoice not found: ${invErr?.message ?? 'unknown'}` }
  }

  if (inv.status === 'void') return blocked('invoice is voided — no BAM copy')

  const bam = (inv as { bams?: { first_name: string; last_name: string; email: string; email_verified_at: string | null } }).bams
  const cohort = (inv as { cohorts?: { bam_copy_mode: string } }).cohorts
  if (!bam) return { invoice_id: invoiceId, ok: false, error: 'bam not found for invoice' }
  if (!cohort) return { invoice_id: invoiceId, ok: false, error: 'cohort not found for invoice' }

  // --- P0-4 HARD BLOCK ---
  if (!bam.email_verified_at) {
    return blocked(
      'BAM email not verified — bams.email_verified_at is NULL. Student must log in via OTP at least once before receiving invoice copies.'
    )
  }

  if (cohort.bam_copy_mode === 'off') {
    return blocked('cohort.bam_copy_mode=off — BAM copies disabled for this cohort')
  }
  // This route can only send for real; it has no draft capability (that is the
  // sendBamCopy Edge Function, which creates an Outlook draft). Fail closed
  // rather than turning the first-cycle "draft" safety setting into a live send.
  if (cohort.bam_copy_mode !== 'live') {
    return blocked(
      `cohort.bam_copy_mode="${cohort.bam_copy_mode}" — this endpoint only performs live sends. ` +
      'Use the draft flow, or set the cohort to live once addresses are confirmed.'
    )
  }

  const recipient = cleanAddress(bam.email)
  const recipientProblem = addressProblem('bam.email', recipient)
  if (recipientProblem) return blocked(recipientProblem)

  const period = new Date(inv.period)
  const monthLong = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const filename = invoicePdfFilename(bam.first_name, bam.last_name, period, inv.invoice_number)
  const appUrl = appBaseUrl()
  const portalUrl = `${appUrl}/portal/dashboard`

  // F1: `if (inv.pdf_key)` meant the attachment was ALWAYS absent, because
  // nothing wrote pdf_key. The BAM's "copy for your records" carried no invoice.
  // Shared render+archive path; reuses the object AP received when there is one.
  const pdf = await ensureInvoicePdf(admin, {
    id: inv.id,
    period: inv.period,
    invoice_number: inv.invoice_number,
    pdf_key: inv.pdf_key,
    payload_json: inv.payload_json
  }, filename)
  if (!pdf.ok) return blocked(pdf.error)
  const attachments = [{ filename, content: Buffer.from(pdf.bytes) }]

  const subject = `Your ${monthLong} invoice is ready: Bud Light U`
  const html = bamCopyEmailHtml(bam.first_name, monthLong, inv.invoice_number, portalUrl, Boolean(attachments))

  // Claim BEFORE sending (P0-B). A failed attempt stays retryable (P0-C).
  const claim = await claimSend(admin, { invoiceId, target: 'bam', mode: 'live', address: recipient })
  if (!claim.ok) return blocked(`${claim.reason}: ${claim.error}`)

  const result = await sendEmail({
    to: recipient,
    subject,
    html,
    attachments
  })

  if (!result.sent) {
    const failMark = await markSendFailed(admin, claim.sendRowId, result.error ?? 'send returned sent=false')
    return {
      invoice_id: invoiceId,
      ok: false,
      provider: result.provider,
      error: [result.error ?? 'send failed', failMark.error].filter(Boolean).join(' | ')
    }
  }

  const marked = await markSendSucceeded(admin, claim.sendRowId, { messageId: result.messageId })
  const trailing = [
    marked.error ? `send record update failed: ${marked.error}` : null,
    pdf.warning
  ].filter(Boolean).join(' | ')
  return {
    invoice_id: invoiceId,
    ok: true,
    provider: result.provider,
    error: trailing ? `SENT, but ${trailing}` : undefined
  }
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
      Your ${month} invoice (${invoiceNumber}) is ready.${attached ? ' A copy is attached.' : ''}
    </p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${portalUrl}"
         style="background: #0073cf; color: #ffffff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
        Log in to your portal
      </a>
    </div>

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      Questions? Ask on the support page in your portal.
    </p>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;" />
    <p style="font-size: 11px; color: #9ca3af; text-align: center;">
      Bud Light U · Campus Ambassador Program · Powered by Salt XC
    </p>
  </div>`
}
