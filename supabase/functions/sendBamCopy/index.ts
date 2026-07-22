/**
 * Edge Function: sendBamCopy — P0-4 fix
 * POST { invoice_id: string, mode: 'draft' | 'live' }
 *
 * Sends the invoice PDF to the BAM's own email as a copy. HARD BLOCK if the
 * BAM hasn't successfully verified their email (i.e. logged in at least once
 * via OTP) — prevents banking-info PDFs going to typo'd addresses.
 */
import { serviceClient } from '../_shared/supabase-admin'
import { invoicePdfFilename } from '../../../lib/invoice-numbering'

export async function handler(req: { invoice_id: string; mode: 'draft' | 'live' }) {
  const db = serviceClient()

  const { data: inv, error: invErr } = await db.from('invoices')
    .select('*, bams(*), cohorts(*)').eq('id', req.invoice_id).single()
  if (invErr || !inv) return { ok: false, error: `invoice not found: ${invErr?.message}` }

  const bam = (inv as any).bams
  const cohort = (inv as any).cohorts

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
  if (!inv.pdf_key) return { ok: false, error: 'pdf not rendered yet' }

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

  const { data: pdfFile, error: pdfErr } = await db.storage.from('invoices').download(inv.pdf_key)
  if (pdfErr || !pdfFile) return { ok: false, error: `pdf download failed: ${pdfErr?.message}` }
  const bytes = new Uint8Array(await pdfFile.arrayBuffer())
  const base64 = btoa(String.fromCharCode(...bytes))

  const token = await getGraphToken()
  if (!token) return { ok: false, error: 'graph auth failed' }

  const graphBody = {
    message: {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: bam.email } }],
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
    : `https://graph.microsoft.com/v1.0/users/${sender}/messages`

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: req.mode === 'live' ? JSON.stringify(graphBody) : JSON.stringify(graphBody.message)
  })
  if (!resp.ok) return { ok: false, error: `graph send failed: ${resp.status} ${await resp.text()}` }

  const messageId = req.mode === 'live' ? null : (await resp.json())?.id ?? null

  await db.from('invoice_sends').insert({
    invoice_id: req.invoice_id,
    target: 'bam',
    mode: req.mode,
    address: bam.email,
    message_id: messageId,
    attempts: 1,
    sent_at: new Date().toISOString()
  })

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
      client_id: clientId, client_secret: secret,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
    })
  })
  if (!resp.ok) return null
  return (await resp.json()).access_token
}
