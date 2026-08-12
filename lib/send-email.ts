/**
 * Shared email-sending helper — provider cascade:
 *   1. Resend      (RESEND_API_KEY) — primary, all emails
 *   2. MS Graph    (MS_CLIENT_ID + MS_CLIENT_SECRET + MS_TENANT_ID) — production AP
 *   3. Gmail SMTP  — disabled (code kept for emergency fallback only)
 *
 * Switch providers by adding/removing env vars. No caller-side changes needed.
 *
 * P1-18 (audit 2026-08-07): every env value that ends up in a mail header or a
 * URL path is sanitized through lib/sanitize. This is the exact bug class that
 * triggered the audit: a U+FEFF in RESEND_FROM_EMAIL produces a From: header
 * that providers reject or silently rewrite, and a U+FEFF in MS_TENANT_ID is
 * percent-encoded to %EF%BB%BF in the login URL, which 404s with nothing
 * suspicious in the logs. Unusable values now fail CLOSED (no send) rather than
 * sending from a corrupt address.
 */
import { createTransport } from 'nodemailer'
import { Resend } from 'resend'
import { cleanEnvValue, cleanText, isEmailAddress, envToken, tokenProblem, envAddressListOr } from './sanitize'

export interface SendEmailOpts {
  to: string | string[]
  cc?: string[]
  subject: string
  html: string
  text?: string
  attachments?: Array<{ filename: string; content: Buffer }>
  from?: string
  /**
   * Where a reply should go. Defaults to REPLY_TO_EMAIL.
   *
   * budlightu.com has NO MX record -- it is a send-only domain -- so a reply to the
   * From address bounces. Meanwhile the invite email tells students "reply to this
   * email", and AP might well reply to an invoice. Without this header those replies
   * went nowhere at all.
   */
  replyTo?: string
}

export interface SendEmailResult {
  sent: boolean
  provider: 'gmail' | 'resend' | 'graph' | 'none'
  messageId?: string | null
  error?: string
}

/**
 * Sanitized From: header builder. Returns null when the address is unusable,
 * so a caller can refuse to send instead of emitting a corrupt header.
 * `cleanText` on the display name also collapses the CR/LF that would let an
 * env value inject an extra header.
 */
/**
 * The address replies should reach, or null when none is configured.
 *
 * Deliberately falls back to nothing rather than to the From address: a Reply-To
 * pointing at a mailbox that does not exist is worse than none, because the sender
 * gets a bounce instead of their mail client showing them there is nowhere to reply.
 */
function replyToHeader(explicit?: string): string | undefined {
  const direct = cleanEnvValue(explicit ?? process.env.REPLY_TO_EMAIL ?? '')
  if (direct) return direct

  // Fall back to the first AP CC address, resolved through the same helper the AP send
  // uses, so it picks up that route's code-level default (robin.graham@) even where the
  // env var is unset. Without a fallback, shipping this would have depended on someone
  // remembering to add a new environment variable, and until they did every reply would
  // keep bouncing off a domain with no MX record. Set REPLY_TO_EMAIL to override.
  const firstCc = envAddressListOr('AP_CC_EMAILS', 'robin.graham@ilovesalt.com')[0]
  return firstCc && firstCc.includes('@') ? firstCc : undefined
}

function fromHeader(addressEnv: string, nameEnv: string | null, defaultName: string | null): string | null {
  const address = cleanEnvValue(process.env[addressEnv])
  if (!address || !isEmailAddress(address)) return null
  const name = cleanText(nameEnv ? process.env[nameEnv] ?? '' : '') || (defaultName ?? '')
  return name ? `${name} <${address}>` : address
}

function gmailFrom(): string | null {
  return fromHeader('GMAIL_USER', 'GMAIL_FROM_NAME', null)
}

function resendFrom(): string | null {
  return fromHeader('RESEND_FROM_EMAIL', null, 'Bud Light U')
}

function gmailConfigured(): boolean {
  return Boolean(cleanEnvValue(process.env.GMAIL_USER) && cleanEnvValue(process.env.GMAIL_APP_PASSWORD))
}

function graphConfigured(): boolean {
  return Boolean(
    cleanEnvValue(process.env.MS_CLIENT_ID) &&
    cleanEnvValue(process.env.MS_CLIENT_SECRET) &&
    cleanEnvValue(process.env.MS_TENANT_ID)
  )
}

export async function sendEmail(opts: SendEmailOpts): Promise<SendEmailResult> {
  if (cleanEnvValue(process.env.RESEND_API_KEY)) return sendViaResend(opts)
  if (gmailConfigured()) return sendViaGmail(opts)
  if (graphConfigured()) return sendViaGraph(opts)
  return { sent: false, provider: 'none', error: 'No email provider configured (set RESEND_API_KEY, or GMAIL_USER+GMAIL_APP_PASSWORD, or MS_CLIENT_ID/SECRET/TENANT)' }
}

// ── Gmail SMTP ──────────────────────────────────────────────────────────────

async function sendViaGmail(opts: SendEmailOpts): Promise<SendEmailResult> {
  const from = opts.from ? cleanEnvValue(opts.from) : gmailFrom()
  if (!from) {
    return { sent: false, provider: 'gmail', error: 'GMAIL_USER is missing or not a usable email address after sanitizing' }
  }
  try {
    const transport = createTransport({
      service: 'gmail',
      auth: {
        user: cleanEnvValue(process.env.GMAIL_USER),
        pass: cleanEnvValue(process.env.GMAIL_APP_PASSWORD),
      },
    })

    const info = await transport.sendMail({
      from,
      to: Array.isArray(opts.to) ? opts.to.join(', ') : opts.to,
      cc: opts.cc?.join(', '),
      replyTo: replyToHeader(opts.replyTo),
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
  // MS_TENANT_ID is spliced into the URL PATH. A BOM there becomes %EF%BB%BF and
  // the request 404s while the value still looks correct in every log, so it is
  // validated as a URL-safe token rather than merely trimmed.
  const tenant = envToken('MS_TENANT_ID')
  const problem = tokenProblem('MS_TENANT_ID', tenant)
  if (problem) {
    console.error('[send-email]', problem)
    return null
  }
  const clientId = cleanEnvValue(process.env.MS_CLIENT_ID)
  const secret = cleanEnvValue(process.env.MS_CLIENT_SECRET)
  if (!clientId || !secret) return null
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
    if (cleanEnvValue(process.env.RESEND_API_KEY)) return sendViaResend(opts)
    if (gmailConfigured()) return sendViaGmail(opts)
    return { sent: false, provider: 'graph', error: 'graph auth failed' }
  }

  const toList = Array.isArray(opts.to) ? opts.to : [opts.to]
  const graphMessage = {
    subject: opts.subject,
    body: { contentType: 'HTML', content: opts.html },
    toRecipients: toList.map(a => ({ emailAddress: { address: a } })),
    ccRecipients: (opts.cc ?? []).map(a => ({ emailAddress: { address: a } })),
    // Graph spells it as a list. Omitted entirely when unset, rather than sent empty.
    ...(replyToHeader(opts.replyTo)
      ? { replyTo: [{ emailAddress: { address: replyToHeader(opts.replyTo) as string } }] }
      : {}),
    attachments: (opts.attachments ?? []).map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: 'application/pdf',
      contentBytes: a.content.toString('base64')
    }))
  }

  // Also a URL path segment (P1-18). Fail closed rather than 404 invisibly.
  const sender = cleanEnvValue(process.env.MS_SENDER_MAILBOX) || 'accounts.payable.dryrun@ilovesalt.com'
  if (!isEmailAddress(sender)) {
    return {
      sent: false,
      provider: 'graph',
      error: `MS_SENDER_MAILBOX is not a usable mailbox after sanitizing: ${JSON.stringify(sender)}`
    }
  }
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
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
  const from = opts.from ? cleanEnvValue(opts.from) : (resendFrom() ?? 'Bud Light U <noreply@budlightu.com>')
  if (!from) {
    return { sent: false, provider: 'resend', error: 'From address is empty after sanitizing' }
  }
  try {
    const resend = new Resend(cleanEnvValue(process.env.RESEND_API_KEY))
    const { data, error } = await resend.emails.send({
      from,
      replyTo: replyToHeader(opts.replyTo),
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
