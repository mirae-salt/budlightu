/**
 * Edge Function: sendBamCopy — P0-4 fix
 * POST { invoice_id: string, mode: 'draft' | 'live' }
 *
 * Sends the invoice PDF to the BAM's own email as a copy. HARD BLOCK if the
 * BAM hasn't successfully verified their email (i.e. logged in at least once
 * via OTP) — prevents banking-info PDFs going to typo'd addresses.
 *
 * AUDIT-2026-08-07 fixes: same as sendApEmail — the send is claimed before the
 * Graph call and the insert error is no longer discarded (P0-B), failures stay
 * retryable instead of permanently blocking (P0-C), MS_SENDER_MAILBOX /
 * MS_TENANT_ID are sanitized and URL-encoded (P1-18), and bam/cohort presence
 * plus every supabase error is checked (P0-H).
 *
 * CRITIC GATE 2026-08-07:
 *  - F1: the `if (!inv.pdf_key)` precondition was unsatisfiable (nothing wrote
 *    pdf_key), so BAM copies never went out. Now uses the shared
 *    lib/invoice-pdf.ts render+archive path.
 *  - F16: chunked base64. The old btoa(String.fromCharCode(...bytes)) throws
 *    RangeError on any PDF above roughly 100 KB.
 */
import { serviceClient } from '../_shared/supabase-admin'
import { invoicePdfFilename } from '../../../lib/invoice-numbering'
import { addressProblem, cleanAddress } from '../../../lib/sanitize'
import { claimSend, markSendDrafted, markSendFailed, markSendSucceeded } from '../../../lib/send-guard'
import { bamCopyEmail } from '../../../lib/bam-copy-email'
import { appBaseUrl } from '../../../lib/app-url'
import { ensureInvoicePdf } from '../../../lib/invoice-pdf'
import { sendEmail } from '../../../lib/send-email'

export async function handler(req: { invoice_id: string; mode: 'draft' | 'live' }) {
  const db = serviceClient()

  const { data: inv, error: invErr } = await db.from('invoices')
    .select('*, bams(*), cohorts(*)').eq('id', req.invoice_id).single()
  if (invErr || !inv) return { ok: false, error: `invoice not found: ${invErr?.message}` }
  if (inv.status === 'void') return { ok: false, error: 'invoice is voided — no BAM copy' }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bam = (inv as any).bams
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cohort = (inv as any).cohorts
  if (!bam) return { ok: false, error: 'bam not found for invoice' }
  if (!cohort) return { ok: false, error: 'cohort not found for invoice' }

  // P0-4 HARD BLOCK: no BAM copy until they've verified their email
  if (!bam.email_verified_at) {
    return {
      ok: false,
      error: 'HARD BLOCK · bams.email_verified_at is NULL — student must log in via OTP at least once before receiving banking PDFs'
    }
  }

  if (cohort.bam_copy_mode === 'off') {
    return { ok: true, skipped: true, reason: 'cohort.bam_copy_mode=off' }
  }
  if (req.mode === 'live' && cohort.bam_copy_mode !== 'live') {
    return { ok: false, error: `cohort.bam_copy_mode=${cohort.bam_copy_mode} does not permit live send` }
  }

  const recipient = cleanAddress(bam.email)
  const recipientProblem = addressProblem('bam.email', recipient)
  if (recipientProblem) return { ok: false, error: recipientProblem }

  const period = new Date(inv.period)
  const filename = invoicePdfFilename(bam.first_name, bam.last_name, period, inv.invoice_number)
  const monthLong = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  /*
   * One builder, shared with nothing else now that the duplicate branded route is
   * gone. Both parts go out: the HTML is what a student sees, and the plain-text
   * alternative is what a spam filter reads, which matters while the sending
   * domain is still waiting on the Salt IT allowlist.
   *
   * The PDF is attached below and the send is refused if it cannot be rendered,
   * so `attached` is true by construction here rather than a guess.
   */
  const mail = bamCopyEmail(bam.first_name, monthLong, inv.invoice_number, `${appBaseUrl()}/portal/invoices`, true)

  // F1: shared render+archive path. Reuses the object AP received when pdf_key
  // is already set, so the BAM's copy is byte-identical to the one AP holds.
  const pdf = await ensureInvoicePdf(db, {
    id: inv.id,
    period: inv.period,
    invoice_number: inv.invoice_number,
    pdf_key: inv.pdf_key,
    payload_json: inv.payload_json
  }, filename)
  if (!pdf.ok) return { ok: false, error: pdf.error }
  // Resend only (Mirae, 2026-08-10). This used to go through Microsoft Graph, and
  // Salt IT never issued the credentials, so every BAM copy failed. Resend has no
  // draft concept, so a dryrun records the intent and emails nobody.
  const claim = await claimSend(db, { invoiceId: req.invoice_id, target: 'bam', mode: req.mode, address: recipient })
  if (!claim.ok) return { ok: false, error: `${claim.reason}: ${claim.error}` }

  if (req.mode !== 'live') {
    const drafted = await markSendDrafted(db, claim.sendRowId, { messageId: null })
    const note = 'Dry run: recorded, and no copy was emailed to the BAM.'
    return {
      ok: true,
      mode: req.mode,
      message_id: null,
      warning: [drafted.error, pdf.warning, note].filter(Boolean).join(' | ')
    }
  }

  const sent = await sendEmail({
    to: recipient,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments: [{ filename, content: Buffer.from(pdf.bytes) }]
  })

  if (!sent.sent) {
    const msg = `BAM copy failed via ${sent.provider}: ${sent.error ?? 'provider reported sent=false'}`
    await markSendFailed(db, claim.sendRowId, msg)
    return { ok: false, error: msg }
  }

  const messageId = sent.messageId ?? null
  const recorded = await markSendSucceeded(db, claim.sendRowId, { messageId })

  const warning = [recorded.error, pdf.warning].filter(Boolean).join(' | ')
  return { ok: true, mode: req.mode, message_id: messageId, warning: warning || undefined }
}

