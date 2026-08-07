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
import { addressProblem, cleanAddress, envAddressOr, envToken, tokenProblem } from '../../../lib/sanitize'
import { claimSend, markSendDrafted, markSendFailed, markSendSucceeded } from '../../../lib/send-guard'
import { ensureInvoicePdf, bytesToBase64 } from '../../../lib/invoice-pdf'

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

  const sender = envAddressOr('MS_SENDER_MAILBOX', 'accounts.payable.dryrun@ilovesalt.com')
  const senderProblem = addressProblem('MS_SENDER_MAILBOX', sender)
  if (senderProblem) return { ok: false, error: senderProblem }

  const period = new Date(inv.period)
  const filename = invoicePdfFilename(bam.first_name, bam.last_name, period, inv.invoice_number)
  const monthLong = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const subject = `Your Bud Light U invoice — ${monthLong}`
  const body = [
    `Hi ${bam.first_name},`,
    '',
    `Your ${monthLong} invoice is attached for your records. Salt AP has also been notified and will process payment on net-15 terms via direct deposit.`,
    '',
    'Questions? Reach out to your program manager, or use the support form in your portal.',
    '',
    'Thanks,',
    'Bud Light U program'
  ].join('\n')

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
  const base64 = bytesToBase64(pdf.bytes)   // F16

  const token = await getGraphToken()
  if (!token.ok) return { ok: false, error: token.error }

  const graphBody = {
    message: {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: recipient } }],
      attachments: [{
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: filename,
        contentType: 'application/pdf',
        contentBytes: base64
      }]
    },
    saveToSentItems: req.mode === 'live'
  }

  const endpoint = req.mode === 'live'
    ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`
    : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/messages`

  const claim = await claimSend(db, { invoiceId: req.invoice_id, target: 'bam', mode: req.mode, address: recipient })
  if (!claim.ok) return { ok: false, error: `${claim.reason}: ${claim.error}` }

  let resp: Response
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
      body: req.mode === 'live' ? JSON.stringify(graphBody) : JSON.stringify(graphBody.message)
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markSendFailed(db, claim.sendRowId, `graph request threw: ${msg}`)
    return { ok: false, error: `graph request threw: ${msg}` }
  }

  if (!resp.ok) {
    const msg = `graph send failed: ${resp.status} ${await resp.text()}`
    await markSendFailed(db, claim.sendRowId, msg)
    return { ok: false, error: msg }
  }

  const messageId = req.mode === 'live' ? null : (await resp.json())?.id ?? null

  const recorded = req.mode === 'live'
    ? await markSendSucceeded(db, claim.sendRowId, { messageId })
    : await markSendDrafted(db, claim.sendRowId, { messageId })

  const warning = [recorded.error, pdf.warning].filter(Boolean).join(' | ')
  return { ok: true, mode: req.mode, message_id: messageId, warning: warning || undefined }
}

async function getGraphToken(): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const tenant = envToken('MS_TENANT_ID')
  const clientId = envToken('MS_CLIENT_ID')
  const secret = process.env.MS_CLIENT_SECRET
  if (!tenant || !clientId || !secret) return { ok: false, error: 'graph auth not configured (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET)' }

  const tenantProblem = tokenProblem('MS_TENANT_ID', tenant)
  if (tenantProblem) return { ok: false, error: tenantProblem }

  const resp = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: secret,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
    })
  })
  if (!resp.ok) return { ok: false, error: `graph auth failed: ${resp.status} ${await resp.text()}` }
  const j = await resp.json()
  if (!j.access_token) return { ok: false, error: 'graph auth returned no access_token' }
  return { ok: true, value: j.access_token }
}
