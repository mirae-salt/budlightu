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
 */
import { serviceClient } from '../_shared/supabase-admin'
import { apEmailSubject, apEmailBody, invoicePdfFilename } from '../../../lib/invoice-numbering'
import { addressProblem, cleanAddress, envAddressOr, envAddressListOr, envToken, tokenProblem } from '../../../lib/sanitize'
import { claimSend, markSendDrafted, markSendFailed, markSendSucceeded } from '../../../lib/send-guard'
import { lookupReimbursement, payloadLedgerMismatch } from '../../../lib/invoice-ledger'
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
  if (!inv.pdf_key) return { ok: false, error: 'pdf not rendered yet' }

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
  const bamEmail = cleanAddress(bam.email)
  if (bamEmail && !addressProblem('bam.email', bamEmail) && !ccList.some(e => e.toLowerCase() === bamEmail.toLowerCase())) {
    ccList.push(bamEmail)
  }

  const sender = envAddressOr('MS_SENDER_MAILBOX', 'accounts.payable.dryrun@ilovesalt.com')
  const senderProblem = addressProblem('MS_SENDER_MAILBOX', sender)
  if (senderProblem) return { ok: false, error: senderProblem }

  const period = new Date(inv.period)
  const monthLong = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const subject = apEmailSubject(bam.first_name, bam.last_name, period, inv.invoice_number)
  const body = apEmailBody(monthLong, cohort.program_label, cohort.po_number)
  const filename = invoicePdfFilename(bam.first_name, bam.last_name, period, inv.invoice_number)

  // Fetch PDF bytes from Storage
  const { data: pdfFile, error: pdfErr } = await db.storage.from('invoices').download(inv.pdf_key)
  if (pdfErr || !pdfFile) return { ok: false, error: `pdf download failed: ${pdfErr?.message}` }
  const bytes = new Uint8Array(await pdfFile.arrayBuffer())
  const base64 = btoa(String.fromCharCode(...bytes))

  // Get Graph token (client credentials flow)
  const token = await getGraphToken()
  if (!token.ok) return { ok: false, error: token.error }

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
    return { ok: true, mode: req.mode, message_id: messageId, warning: drafted.error }
  }

  const marked = await markSendSucceeded(db, claim.sendRowId, { messageId })
  const { error: statusErr } = await db.from('invoices')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', req.invoice_id)

  const warning = [marked.error, statusErr ? `invoices.status update failed: ${statusErr.message}` : null]
    .filter(Boolean)
    .join(' | ')

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
