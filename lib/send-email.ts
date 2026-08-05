/**
 * Shared email-sending helper — provider cascade:
 *   1. Resend      (RESEND_API_KEY) — primary, all emails
 *   2. MS Graph    (MS_CLIENT_ID + MS_CLIENT_SECRET + MS_TENANT_ID) — production AP
 *   3. Gmail SMTP  — disabled (code kept for emergency fallback only)
 *
 * Switch providers by adding/removing env vars. No caller-side changes needed.
 */
import { createTransport } from 'nodemailer'
import { Resend } from 'resend'

export interface SendEmailOpts {
  to: string | string[]
  cc?: string[]
  subject: string
  html: string
  text?: string
  attachments?: Array<{ filename: string; content: Buffer }>
  from?: string
}

export interface SendEmailResult {
  sent: boolean
  provider: 'gmail' | 'resend' | 'graph' | 'none'
  messageId?: string | null
  error?: string
}

const DEFAULT_FROM_GMAIL = process.env.GMAIL_FROM_NAME
  ? `${process.env.GMAIL_FROM_NAME} <${process.env.GMAIL_USER}>`
  : process.env.GMAIL_USER ?? 'noreply@gmail.com'

const DEFAULT_FROM_RESEND = process.env.RESEND_FROM_EMAIL
  ? `Bud Light U <${process.env.RESEND_FROM_EMAIL}>`
  : 'Bud Light U <noreply@budlightu.com>'

function gmailConfigured(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
}

function graphConfigured(): boolean {
  return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MS_TENANT_ID)
}

export async function sendEmail(opts: SendEmailOpts): Promise<SendEmailResult> {
  if (process.env.RESEND_API_KEY) return sendViaResend(opts)
  if (gmailConfigured()) return sendViaGmail(opts)
  if (graphConfigured()) return sendViaGraph(opts)
  return { sent: false, provider: 'none', error: 'No email provider configured (set RESEND_API_KEY, or GMAIL_USER+GMAIL_APP_PASSWORD, or MS_CLIENT_ID/SECRET/TENANT)' }
}

// ── Gmail SMTP ──────────────────────────────────────────────────────────────

async function sendViaGmail(opts: SendEmailOpts): Promise<SendEmailResult> {
  try {
    const transport = createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER!,
        pass: process.env.GMAIL_APP_PASSWORD!,
      },
    })

    const info = await transport.sendMail({
      from: opts.from ?? DEFAULT_FROM_GMAIL,
      to: Array.isArray(opts.to) ? opts.to.join(', ') : opts.to,
      cc: opts.cc?.join(', '),
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      attachments: opts.attachments?.map(a => ({
        filename: a.filename,
        content: a.content,
      })),
    })

    return { sent: true, provider: 'gmail', messageId: info.messageId ?? null }
  } catch (e: unknown) {
    return { sent: false, provider: 'gmail', error: e instanceof Error ? e.message : 'gmail send failed' }
  }
}

// ── MS Graph ────────────────────────────────────────────────────────────────

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
  return j.access_token ?? null
}

async function sendViaGraph(opts: SendEmailOpts): Promise<SendEmailResult> {
  const token = await getGraphToken()
  if (!token) {
    if (process.env.RESEND_API_KEY) return sendViaResend(opts)
    if (gmailConfigured()) return sendViaGmail(opts)
    return { sent: false, provider: 'graph', error: 'graph auth failed' }
  }

  const toList = Array.isArray(opts.to) ? opts.to : [opts.to]
  const graphMessage = {
    subject: opts.subject,
    body: { contentType: 'HTML', content: opts.html },
    toRecipients: toList.map(a => ({ emailAddress: { address: a } })),
    ccRecipients: (opts.cc ?? []).map(a => ({ emailAddress: { address: a } })),
    attachments: (opts.attachments ?? []).map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: 'application/pdf',
      contentBytes: a.content.toString('base64')
    }))
  }

  const sender = process.env.MS_SENDER_MAILBOX ?? 'accounts.payable.dryrun@ilovesalt.com'
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: graphMessage, saveToSentItems: true })
  })

  if (!resp.ok) {
    const err = await resp.text()
    return { sent: false, provider: 'graph', error: `graph send failed: ${resp.status} ${err}` }
  }

  return { sent: true, provider: 'graph', messageId: null }
}

// ── Resend (fallback) ───────────────────────────────────────────────────────

async function sendViaResend(opts: SendEmailOpts): Promise<SendEmailResult> {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY!)
    const { data, error } = await resend.emails.send({
      from: opts.from ?? DEFAULT_FROM_RESEND,
      to: opts.to,
      cc: opts.cc,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      attachments: opts.attachments?.map(a => ({
        filename: a.filename,
        content: a.content
      }))
    })
    if (error) {
      return { sent: false, provider: 'resend', error: error.message }
    }
    return { sent: true, provider: 'resend', messageId: data?.id ?? null }
  } catch (e: unknown) {
    return { sent: false, provider: 'resend', error: e instanceof Error ? e.message : 'resend send failed' }
  }
}
