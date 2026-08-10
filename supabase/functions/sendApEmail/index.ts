/**
 * Edge Function: sendApEmail
 * POST { invoice_id: string, mode: 'dryrun' | 'live' }
 *
 * Sends the AP email via Microsoft Graph (Outlook). In dryrun mode, creates
 * a draft only.
 *
 * AUDIT-2026-08-07 fixes:
 *  - P0-B: the old docstring claimed "idempotent via invoice_sends UNIQUE" but
 *    there was NO pre-send check. It sent first, inserted afterwards, discarded
 *    the insert error and re-set invoices.status='sent', so a second call sent a
 *    second AP email and returned ok. Duplicate AP email = duplicate real
 *    payment. The send is now claimed via lib/send-guard.ts before the Graph
 *    call, and a partial unique index makes a second completed send impossible.
 *  - P0-C: failures are recorded as retryable instead of poisoning the record.
 *  - P0-D: the reimbursement line on payload_json is reconciled against
 *    reimbursement_ledger.paid_cad; any mismatch refuses the send.
 *  - P1-1: a live send additionally requires cohort.send_mode='live'.
 *  - P1-18: MS_SENDER_MAILBOX / MS_TENANT_ID are sanitized, validated and
 *    URL-encoded. A BOM in either becomes %EF%BB%BF in the Graph path and 404s
 *    invisibly — the exact bug class as the invite-link incident.
 *  - P0-H: bam/cohort presence and every supabase error are checked.
 *
 * CRITIC GATE 2026-08-07 fixes:
 *  - F1: `if (!inv.pdf_key) return {ok:false,'pdf not rendered yet'}` was an
 *    unsatisfiable precondition — nothing in the codebase wrote pdf_key, so this
 *    function could never send and batch-approve could never approve. The PDF
 *    now comes from lib/invoice-pdf.ts:ensureInvoicePdf, which renders from
 *    payload_json, archives to the `invoices` bucket and writes pdf_key.
 *  - F4: the BAM is CC'd only when email_verified_at is set AND consent_ap_cc is
 *    true. It used to be CC'd after nothing but a format check, which walked
 *    around the P0-4 control that sendBamCopy enforces two files over.
 *  - F16: base64 goes through bytesToBase64. `btoa(String.fromCharCode(...bytes))`
 *    spreads every byte as an argument and throws RangeError above ~100 KB, i.e.
 *    on any real invoice PDF.
 */
import { serviceClient } from '../_shared/supabase-admin'
import { apEmailSubject, apEmailBody, invoicePdfFilename } from '../../../lib/invoice-numbering'
import { addressProblem, cleanAddress, envAddressOr, envAddressListOr, envToken, tokenProblem } from '../../../lib/sanitize'
import { claimSend, markSendDrafted, markSendFailed, markSendSucceeded } from '../../../lib/send-guard'
import { lookupReimbursement, payloadLedgerMismatch } from '../../../lib/invoice-ledger'
import { ensureInvoicePdf, bytesToBase64 } from '../../../lib/invoice-pdf'
import { bamCcProblem } from '../../../lib/bam-cc'
import { sendEmail } from '../../../lib/send-email'
import type { InvoicePayload } from '../../../lib/invoice-payload'

export async function handler(req: { invoice_id: string; mode: 'dryrun' | 'live' }) {
  const db = serviceClient()

  const AP_TO = envAddressOr('AP_EMAIL', 'accounts.payable@ilovesalt.com')
  const AP_CC = envAddressListOr('AP_CC_EMAILS', 'robin.graham@ilovesalt.com,nb@ilovesalt.com')

  // Look up invoice + BAM + cohort + PDF
  const { data: inv, error: invErr } = await db.from('invoices').select('*, bams(*), cohorts(*)').eq('id', req.invoice_id).single()
  if (invErr || !inv) return { ok: false, error: `invoice not found: ${invErr?.message}` }
  if (inv.status === 'void') return { ok: false, error: 'invoice is voided — cannot send to AP' }
  if (req.mode === 'live' && (inv.status === 'sent' || inv.status === 'paid')) {
    return { ok: false, error: `invoice status is already ${inv.status} — refusing to re-send to AP` }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bam = (inv as any).bams
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cohort = (inv as any).cohorts
  if (!bam) return { ok: false, error: 'bam not found for invoice' }
  if (!cohort) return { ok: false, error: 'cohort not found for invoice' }
  if (!cohort.po_number) return { ok: false, error: 'cohort.po_number missing — HARD BLOCK' }
  if (req.mode === 'live' && cohort.send_mode !== 'live') {
    return { ok: false, error: `cohort.send_mode="${cohort.send_mode}" does not permit a live AP send` }
  }

  // P0-D: the document must agree with the ledger before anything leaves.
  const ledger = await lookupReimbursement(db, inv.bam_id, inv.cohort_id, inv.period)
  if (!ledger.ok) return { ok: false, error: ledger.error }
  const payloadLines = (inv.payload_json as unknown as InvoicePayload | null)?.lines
  const mismatch = payloadLedgerMismatch(payloadLines, ledger.paidCad)
  if (mismatch) return { ok: false, error: mismatch }

  // P1-18: sanitize/validate every address and URL segment.
  const toProblem = addressProblem('AP_EMAIL', AP_TO)
  if (toProblem) return { ok: false, error: toProblem }

  const ccList: string[] = []
  for (const [i, raw] of AP_CC.entries()) {
    const addr = cleanAddress(raw)
    const problem = addressProblem(`AP_CC_EMAILS[${i}]`, addr)
    if (problem) return { ok: false, error: problem }
    ccList.push(addr)
  }
  // F4: verified + consented only (lib/bam-cc.ts). Never blocks the AP email
  // itself; AP still has to be paid.
  let ccNote: string | undefined = bamCcProblem(bam) ?? undefined
  if (!ccNote) {
    const bamEmail = cleanAddress(bam.email)
    const formatProblem = addressProblem('bam.email', bamEmail)
    if (formatProblem) {
      ccNote = `BAM not CC'd: ${formatProblem}`
    } else if (!ccList.some(e => e.toLowerCase() === bamEmail.toLowerCase())) {
      ccList.push(bamEmail)
    }
  }

  const sender = envAddressOr('MS_SENDER_MAILBOX', 'accounts.payable.dryrun@ilovesalt.com')
  const senderProblem = addressProblem('MS_SENDER_MAILBOX', sender)
  if (senderProblem) return { ok: false, error: senderProblem }

  const period = new Date(inv.period)
  const monthLong = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const subject = apEmailSubject(bam.first_name, bam.last_name, period, inv.invoice_number)
  const body = apEmailBody(monthLong, cohort.program_label, cohort.po_number)
  const filename = invoicePdfFilename(bam.first_name, bam.last_name, period, inv.invoice_number)

  // F1: single render/archive path — reuses the stored object when pdf_key is
  // already set, otherwise renders from payload_json, uploads and records the key.
  const pdf = await ensureInvoicePdf(db, {
    id: inv.id,
    period: inv.period,
    invoice_number: inv.invoice_number,
    pdf_key: inv.pdf_key,
    payload_json: inv.payload_json
  }, filename)
  if (!pdf.ok) return { ok: false, error: pdf.error }
  const base64 = bytesToBase64(pdf.bytes)   // F16: chunked, no argument spread

  // ── Provider choice ───────────────────────────────────────────────────────
  // MS Graph is preferred (the AP mailbox lives in Outlook), but Salt IT has not
  // issued Graph credentials, and MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET
  // are absent from production. That created a deadlock in which nobody could be
  // paid: batch-approve only sets status='approved' when this function returns ok,
  // and /api/admin/send-ap refuses anything that is not already 'approved'. So a
  // missing Graph credential silently blocked BOTH senders.
  //
  // When Graph is unavailable we fall back to the shared cascade in
  // lib/send-email.ts, which prefers Resend and is already configured. Resend has
  // no concept of a draft, so a dryrun records the intent without emailing anyone,
  // which is what dryrun is for, and says so rather than implying a draft is
  // waiting in Outlook.
  const token = await getGraphToken()

  if (!token.ok) {
    const claim = await claimSend(db, { invoiceId: req.invoice_id, target: 'ap', mode: req.mode, address: AP_TO })
    if (!claim.ok) return { ok: false, error: `${claim.reason}: ${claim.error}` }

    if (req.mode !== 'live') {
      const drafted = await markSendDrafted(db, claim.sendRowId, { messageId: null })
      const note = 'Recorded as a dry run. Microsoft Graph is not configured, so no Outlook draft was created and no email was sent.'
      const draftWarning = [drafted.error, pdf.warning, ccNote, note].filter(Boolean).join(' | ')
      return { ok: true, mode: req.mode, message_id: null, warning: draftWarning }
    }

    const sent = await sendEmail({
      to: AP_TO,
      cc: ccList,
      subject,
      text: body,
      html: `<pre style="font-family: inherit; white-space: pre-wrap; margin: 0;">${escapeHtml(body)}</pre>`,
      attachments: [{ filename, content: Buffer.from(pdf.bytes) }]
    })

    if (!sent.sent) {
      const msg = `AP send failed via ${sent.provider}: ${sent.error ?? 'provider reported sent=false'}`
      await markSendFailed(db, claim.sendRowId, msg)
      return { ok: false, error: msg }
    }

    const marked = await markSendSucceeded(db, claim.sendRowId, { messageId: sent.messageId ?? null })
    const { error: statusErr } = await db.from('invoices')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', req.invoice_id)

    const warning = [
      marked.error,
      statusErr ? `invoices.status update failed: ${statusErr.message}` : null,
      pdf.warning,
      ccNote,
      `Sent via ${sent.provider} because Microsoft Graph is not configured.`
    ].filter(Boolean).join(' | ')

    return { ok: true, mode: req.mode, message_id: sent.messageId ?? null, warning: warning || undefined }
  }

  const graphBody = {
    message: {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: AP_TO } }],
      ccRecipients: ccList.map((a: string) => ({ emailAddress: { address: a } })),
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
    : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/messages`  // create draft

  // P0-B: claim before the external call.
  const claim = await claimSend(db, { invoiceId: req.invoice_id, target: 'ap', mode: req.mode, address: AP_TO })
  if (!claim.ok) return { ok: false, error: `${claim.reason}: ${claim.error}` }

  let resp: Response
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.value}`,
        'Content-Type': 'application/json'
      },
      body: req.mode === 'live' ? JSON.stringify(graphBody) : JSON.stringify(graphBody.message)
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markSendFailed(db, claim.sendRowId, `graph request threw: ${msg}`)
    return { ok: false, error: `graph request threw: ${msg}` }
  }

  if (!resp.ok) {
    const err = await resp.text()
    const msg = `graph send failed: ${resp.status} ${err}`
    await markSendFailed(db, claim.sendRowId, msg)
    return { ok: false, error: msg }
  }

  const graphResponse = req.mode === 'live' ? {} : await resp.json()
  const messageId = graphResponse?.id ?? null

  if (req.mode !== 'live') {
    // Draft only — nothing was sent, so sent_at stays NULL and the later live
    // send is not blocked (P0-C).
    const drafted = await markSendDrafted(db, claim.sendRowId, { messageId })
    const draftWarning = [drafted.error, pdf.warning, ccNote].filter(Boolean).join(' | ')
    return { ok: true, mode: req.mode, message_id: messageId, warning: draftWarning || undefined }
  }

  const marked = await markSendSucceeded(db, claim.sendRowId, { messageId })
  const { error: statusErr } = await db.from('invoices')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', req.invoice_id)

  const warning = [
    marked.error,
    statusErr ? `invoices.status update failed: ${statusErr.message}` : null,
    pdf.warning,
    ccNote
  ]
    .filter(Boolean)
    .join(' | ')

  return { ok: true, mode: req.mode, message_id: messageId, warning: warning || undefined }
}

/** The AP body is plain text; escape it before dropping it into an HTML part. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
      client_id: clientId,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  })
  if (!resp.ok) return { ok: false, error: `graph auth failed: ${resp.status} ${await resp.text()}` }
  const j = await resp.json()
  if (!j.access_token) return { ok: false, error: 'graph auth returned no access_token' }
  return { ok: true, value: j.access_token }
}
