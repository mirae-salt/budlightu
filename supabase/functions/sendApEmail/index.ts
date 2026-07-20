/**
 * Edge Function: sendApEmail
 * POST { invoice_id: string, mode: 'dryrun' | 'live' }
 *
 * Sends the AP email via Microsoft Graph (Outlook). In dryrun mode, creates
 * a draft only. Idempotent via invoice_sends UNIQUE(invoice_id,target,mode).
 */
import { serviceClient } from '../_shared/supabase-admin'
import { apEmailSubject, apEmailBody, invoicePdfFilename } from '../../../lib/invoice-numbering'

const AP_TO = 'accounts.payable@ilovesalt.com'
const AP_CC = ['Jenna.Greenspoon@ilovesalt.com', 'robin.graham@ilovesalt.com']

export async function handler(req: { invoice_id: string; mode: 'dryrun' | 'live' }) {
  const db = serviceClient()

  // Look up invoice + BAM + cohort + PDF
  const { data: inv, error: invErr } = await db.from('invoices').select('*, bams(*), cohorts(*)').eq('id', req.invoice_id).single()
  if (invErr || !inv) return { ok: false, error: `invoice not found: ${invErr?.message}` }

  const bam = (inv as any).bams
  const cohort = (inv as any).cohorts
  if (!cohort.po_number) return { ok: false, error: 'cohort.po_number missing — HARD BLOCK' }
  if (!inv.pdf_key) return { ok: false, error: 'pdf not rendered yet' }

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
  if (!token) return { ok: false, error: 'graph auth failed' }

  const graphBody = {
    message: {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: AP_TO } }],
      ccRecipients: AP_CC.map(a => ({ emailAddress: { address: a } })),
      attachments: [{
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: filename,
        contentType: 'application/pdf',
        contentBytes: base64
      }]
    },
    saveToSentItems: req.mode === 'live'
  }

  const sender = process.env.MS_SENDER_MAILBOX ?? 'accounts.payable.dryrun@ilovesalt.com'
  const endpoint = req.mode === 'live'
    ? `https://graph.microsoft.com/v1.0/users/${sender}/sendMail`
    : `https://graph.microsoft.com/v1.0/users/${sender}/messages`  // create draft

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: req.mode === 'live' ? JSON.stringify(graphBody) : JSON.stringify(graphBody.message)
  })
  if (!resp.ok) {
    const err = await resp.text()
    return { ok: false, error: `graph send failed: ${resp.status} ${err}` }
  }

  const graphResponse = req.mode === 'live' ? {} : await resp.json()
  const messageId = graphResponse?.id ?? null

  // Record in invoice_sends (UNIQUE constraint enforces idempotency)
  await db.from('invoice_sends').insert({
    invoice_id: req.invoice_id,
    target: 'ap',
    mode: req.mode,
    address: AP_TO,
    message_id: messageId,
    attempts: 1,
    sent_at: new Date().toISOString()
  })

  if (req.mode === 'live') {
    await db.from('invoices').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', req.invoice_id)
  }

  return { ok: true, mode: req.mode, message_id: messageId }
}

async function getGraphToken(): Promise<string | null> {
  const tenant = process.env.MS_TENANT_ID
  const clientId = process.env.MS_CLIENT_ID
  const secret = process.env.MS_CLIENT_SECRET
  if (!tenant || !clientId || !secret) return null
  const resp = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  })
  if (!resp.ok) return null
  const j = await resp.json()
  return j.access_token
}
