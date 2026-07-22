/**
 * Shared email-sending helper. Resend is the default provider (no MS creds
 * required to start testing). When MS_CLIENT_ID + MS_CLIENT_SECRET +
 * MS_TENANT_ID are all present, MS Graph is used instead — this lets us
 * flip providers later (once Shane confirms Graph app perms) with zero
 * caller-side code changes.
 *
 * Pure function, no Next.js/Deno-specific imports — safe to import from both
 * app/api routes (Node) and, if ever needed, re-adapted for Edge Functions.
 */
import { Resend } from 'resend'

export interface SendEmailOpts {
  to: string | string[]
  cc?: string[]
  subject: string
  html: string
  /** plain-text fallback; if omitted, Resend/Graph will derive from html where possible */
  text?: string
  attachments?: Array<{ filename: string; content: Buffer }>
  /** overrides the default from-address */
  from?: string
}

export interface SendEmailResult {
  sent: boolean
  provider: 'resend' | 'graph' | 'none'
  messageId?: string | null
  error?: string
}

const DEFAULT_FROM = 'Bud Light U <onboarding@resend.dev>'

function graphConfigured(): boolean {
  return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MS_TENANT_ID)
}

export async function sendEmail(opts: SendEmailOpts): Promise<SendEmailResult> {
  // Prefer MS Graph when fully configured (production-grade upgrade path);
  // otherwise fall back to Resend if its key is present.
  if (graphConfigured()) {
    return sendViaGraph(opts)
  }
  if (process.env.RESEND_API_KEY) {
    return sendViaResend(opts)
  }
  return { sent: false, provider: 'none', error: 'No email provider configured (set RESEND_API_KEY or MS_CLIENT_ID/MS_CLIENT_SECRET/MS_TENANT_ID)' }
}

async function sendViaResend(opts: SendEmailOpts): Promise<SendEmailResult> {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY!)
    const { data, error } = await resend.emails.send({
      from: opts.from ?? DEFAULT_FROM,
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
    // graceful fallback: if Graph creds are half-set or auth fails, try Resend
    // rather than hard-failing (keeps sends flowing during Graph app approval).
    if (process.env.RESEND_API_KEY) return sendViaResend(opts)
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

  // sendMail returns 202 with no body
  return { sent: true, provider: 'graph', messageId: null }
}
