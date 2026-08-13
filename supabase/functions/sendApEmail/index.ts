/**
 * Edge Function: sendApEmail
 * POST { invoice_id: string, mode: 'dryrun' | 'live' }
 *
 * Sends the AP email via Resend (lib/send-email.ts). A dryrun records the intent
 * and emails nobody.
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
import { addressProblem, cleanAddress } from '../../../lib/sanitize'
import { resolveApAddresses } from '../../../lib/ap-addresses'
import { claimSend, markSendDrafted, markSendFailed, markSendSucceeded } from '../../../lib/send-guard'
import { lookupReimbursement, payloadLedgerMismatch, undecidedReceiptsProblem } from '../../../lib/invoice-ledger'
import { ensureInvoicePdf } from '../../../lib/invoice-pdf'
import { bamCcProblem } from '../../../lib/bam-cc'
import { sendEmail } from '../../../lib/send-email'
import { notifyBam } from '../../../lib/notify-bam'
import type { InvoicePayload } from '../../../lib/invoice-payload'

export async function handler(req: { invoice_id: string; mode: 'dryrun' | 'live' }) {
  const db = serviceClient()

  // Policy first, environment as the fallback, resolved per call. See lib/ap-addresses.ts for
  // why the env read stays: this function deploys separately and can run before the policy row
  // exists. It refuses rather than guessing when the setting is present but unreadable.
  const apAddr = await resolveApAddresses(db)
  if (!apAddr.ok) return { ok: false, error: apAddr.error }
  const AP_TO = apAddr.to
  const AP_CC = apAddr.cc

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
  // See undecidedReceiptsProblem: matching the ledger is not enough when a receipt for this
  // month is still waiting on a decision.
  const undecided = await undecidedReceiptsProblem(db, inv.bam_id, inv.period)
  if (undecided) return { ok: false, error: undecided }

  // P1-18: sanitize/validate every address and URL segment.
  const toProblem = addressProblem('AP recipient', AP_TO)
  if (toProblem) return { ok: false, error: toProblem }

  const ccList: string[] = []
  for (const [i, raw] of AP_CC.entries()) {
    const addr = cleanAddress(raw)
    const problem = addressProblem(`CC ${i + 1}`, addr)
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

  // ── Send ──────────────────────────────────────────────────────────────────
  // Resend only (Mirae, 2026-08-10: "메일발송은 무조건 resend").
  //
  // This used to go through Microsoft Graph, and Salt IT never issued the
  // credentials, which deadlocked payment entirely: batch-approve sets
  // invoices.status='approved' only when this function returns ok, and
  // /api/admin/send-ap refuses anything not already 'approved'. One missing
  // credential silently blocked both senders, so no invoice could reach AP.
  //
  // lib/send-email.ts holds the provider choice for the whole app and prefers
  // Resend. The Graph implementation was deleted rather than left as a dormant
  // preferred path; `git log` has it if IT ever issues credentials.
  //
  // Resend has no draft concept, so a dryrun records the intent and emails nobody,
  // which is what dryrun is for, and says so rather than implying a draft is
  // waiting in an Outlook folder.
  const claim = await claimSend(db, { invoiceId: req.invoice_id, target: 'ap', mode: req.mode, address: AP_TO })
  if (!claim.ok) return { ok: false, error: `${claim.reason}: ${claim.error}` }

  if (req.mode !== 'live') {
    const drafted = await markSendDrafted(db, claim.sendRowId, { messageId: null })
    const note = 'Dry run: recorded, and no email was sent to AP.'
    return {
      ok: true,
      mode: req.mode,
      message_id: null,
      warning: [drafted.error, pdf.warning, ccNote, note].filter(Boolean).join(' | ')
    }
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

  // The student's status board, same entry the other sender writes. Below the dryrun return
  // on purpose: a rehearsal must not tell a student their invoice went out.
  const notified = await notifyBam({
    bam_id: inv.bam_id,
    type: 'invoice_sent',
    title: `Your ${monthLong} invoice was sent for payment`,
    body: `Invoice ${inv.invoice_number}`,
    link: '/portal/invoices',
    period: inv.period
  })

  const warning = [
    marked.error,
    statusErr ? `invoices.status update failed: ${statusErr.message}` : null,
    notified.ok ? null : `portal notification not recorded: ${notified.error}`,
    pdf.warning,
    ccNote
  ].filter(Boolean).join(' | ')

  return { ok: true, mode: req.mode, message_id: sent.messageId ?? null, warning: warning || undefined }
}

/** The AP body is plain text; escape it before dropping it into the HTML part. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
