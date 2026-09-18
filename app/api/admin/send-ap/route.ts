/**
 * POST /api/admin/send-ap  { invoice_id } or { invoice_ids: string[] }
 *
 * Sends invoice(s) to Salt AP (accounts.payable@ilovesalt.com), CC Robin/Nathan.
 * Provider is picked automatically by lib/send-email.ts (Resend by default,
 * MS Graph once creds land). 1 PDF per email — AP does not accept batching.
 *
 * AUDIT-2026-08-07 fixes in this file:
 *  - P0-B: real pre-send idempotency. The old guard used .maybeSingle() without
 *    .eq('mode') and discarded the error, so with two rows for target='ap' it
 *    returned data=null + error and the guard *passed* → a duplicate AP email,
 *    i.e. a duplicate real payment. Now lib/send-guard.ts claims the send before
 *    the external call and a partial unique index makes a second completed send
 *    structurally impossible.
 *  - P0-C: failures no longer block retries forever. They were being written as
 *    mode:'dryrun', which the old guard read as "already sent" with no reset
 *    path outside manual SQL, so the BAM was never paid.
 *  - P0-D: the reimbursement amount on the payload is reconciled against
 *    reimbursement_ledger.paid_cad and the send is refused on any mismatch.
 *  - P1-1: cohort.send_mode is actually honoured here. Only the Edge Function
 *    read it, and the UI calls this route, so one click sent real mail to AP.
 *  - P1-18: AP_EMAIL / AP_CC_EMAILS are sanitized and validated (BOM class).
 *  - P0-H: every supabase error is inspected.
 *
 * CRITIC GATE 2026-08-07 fixes in this file:
 *  - F1: the PDF comes from lib/invoice-pdf.ts:ensureInvoicePdf, the single
 *    render+archive path shared with batch-approve and the Edge Functions, so
 *    `invoices.pdf_key` is actually written. This route also now requires
 *    status='approved' unless an explicit test_email is supplied, so touchpoint
 *    2 (batch approval) cannot be bypassed by clicking "Send AP" on a draft.
 *  - F4: the BAM is CC'd only when bams.email_verified_at is set AND they
 *    consented (bams.consent_ap_cc). A roster typo otherwise mails a stranger a
 *    PDF containing a home address and a full bank account number.
 *  - F13: the dev auth bypass can no longer perform a live AP send.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, denied } from '../../../../lib/admin-auth'

// Same reason as batch-approve: this route also loops, and a batch killed halfway leaves
// some invoices at AP and some not, with nothing on screen saying which were which.
export const maxDuration = 300
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../lib/send-email'
import { apEmailSubject, apEmailBody, invoicePdfFilename } from '../../../../lib/invoice-numbering'
import type { InvoicePayload } from '../../../../lib/invoice-payload'
import { addressProblem, cleanAddress } from '../../../../lib/sanitize'
import { resolveApAddresses } from '../../../../lib/ap-addresses'
import { claimSend, markSendFailed, markSendSucceeded } from '../../../../lib/send-guard'
import { ensureInvoicePdf } from '../../../../lib/invoice-pdf'
import { bamCcProblem } from '../../../../lib/bam-cc'
import { lookupReimbursement, payloadLedgerMismatch, undecidedReceiptsProblem } from '../../../../lib/invoice-ledger'
import { notifyBam } from '../../../../lib/notify-bam'
import { handler as sendBamCopy } from '../../../../supabase/functions/sendBamCopy/index'

/*
 * The AP recipient and CC list are no longer module constants read from the environment.
 *
 * They come from lib/ap-addresses.ts, which reads the `policy` row Robin can edit on
 * /admin/settings and falls back to the same env vars and the same defaults that used to be
 * on these two lines. Module scope was also wrong for a value someone can change while the
 * process is alive: it was captured once per cold start, so an edit took effect whenever
 * Vercel happened to recycle the lambda.
 */

interface SendOutcome {
  invoice_id: string
  ok: boolean
  blocked?: boolean
  provider?: string
  error?: string
  /** Non-fatal notes: PDF not archived, BAM not CC'd, etc. */
  warnings?: string[]
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const invoiceIds: string[] = body.invoice_ids ?? (body.invoice_id ? [body.invoice_id] : [])
  const testEmail: string | undefined = body.test_email
  if (!invoiceIds.length) {
    return NextResponse.json({ ok: false, message: 'invoice_id or invoice_ids required' }, { status: 400 })
  }

  // --- auth: admin only (P0-A). The role comes from app_metadata via
  // lib/admin-auth; the dev bypass still needs NODE_ENV=development AND
  // ALLOW_DEV_AUTH_BYPASS=true, and a missing Supabase env now denies (503)
  // instead of skipping the check.
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  // F13: the two-flag dev bypass (NODE_ENV=development AND ALLOW_DEV_AUTH_BYPASS)
  // is unreachable in a Vercel production build, but a developer running locally
  // is usually pointed at the PRODUCTION Supabase project. Nothing about that
  // combination should be able to mail accounts.payable@. A test send to an
  // explicit address is still allowed — that is how the pipeline gets verified.
  if (auth.devBypass && !testEmail) {
    return NextResponse.json({
      ok: false,
      message:
        'Dev auth bypass is active. A live AP send is refused. ' +
        'Sign in as a real admin, or pass test_email to send to yourself.'
    }, { status: 403 })
  }

  const admin = serviceClient()
  const outcomes: SendOutcome[] = []

  for (const invoiceId of invoiceIds) {
    const outcome = await sendOneInvoiceToAp(admin, invoiceId, testEmail)
    outcomes.push(outcome)
    /*
     * WHO SENT THIS INVOICE (2026-09-18).
     *
     * The triggers on `invoices` and `invoice_sends` run as the service role and record
     * actor_role 'bam', actor_id null, and `invoice_sends` has no column for a person.
     * So a send left no trace of who caused it -- which is exactly the question nobody
     * could answer about September's first 16.
     *
     * Per invoice, not once per batch: a run cut short still leaves a row for each
     * invoice that actually went out. A failed audit write never fails the send, because
     * the email has already left.
     */
    await admin.from('audit_log').insert({
      actor_id: auth.devBypass ? null : auth.userId,
      actor_role: auth.role,
      entity: 'invoices',
      entity_id: invoiceId,
      action: 'send_ap',
      before_json: null,
      after_json: {
        actor_email: auth.email,
        batch_size: invoiceIds.length,
        ok: outcome.ok,
        ...(testEmail ? { test_email: true } : {}),
        ...(outcome.blocked ? { blocked: true } : {}),
        ...(outcome.error ? { error: outcome.error } : {})
      }
    })
  }

  const sent = outcomes.filter(o => o.ok).length
  const blocked = outcomes.filter(o => !o.ok && o.blocked).length
  const failed = outcomes.length - sent - blocked

  return NextResponse.json({ ok: failed === 0 && blocked === 0, sent, blocked, failed, results: outcomes })
}

async function sendOneInvoiceToAp(admin: ReturnType<typeof serviceClient>, invoiceId: string, testEmail?: string): Promise<SendOutcome> {
  const blocked = (error: string): SendOutcome => ({ invoice_id: invoiceId, ok: false, blocked: true, error })

  const { data: inv, error: invErr } = await admin
    .from('invoices')
    // NOTE: keep this as ONE string literal. supabase-js infers the row type from
    // the literal; a concatenated expression degrades it to GenericStringError and
    // every field access below becomes a type error.
    .select('*, payload_json, bams(first_name, last_name, email, email_verified_at, consent_ap_cc), cohorts(po_number, program_label, send_mode, bam_copy_mode)')
    .eq('id', invoiceId)
    .single()

  if (invErr || !inv) {
    return { invoice_id: invoiceId, ok: false, error: `invoice not found: ${invErr?.message ?? 'unknown'}` }
  }

  if (inv.status === 'void') {
    return blocked('invoice is voided — cannot send to AP')
  }
  if (!testEmail && (inv.status === 'sent' || inv.status === 'paid')) {
    return blocked(`invoice status is already ${inv.status} — refusing to re-send to AP`)
  }
  // F1: touchpoint 2 is the approval gate. A draft has not been through it, so
  // this endpoint refuses it rather than letting one click bypass batch approval.
  if (!testEmail && inv.status !== 'approved') {
    return blocked(
      `invoice status is "${inv.status}" — only an approved invoice can be sent to AP. ` +
      'Run batch approval (touchpoint 2) first, or use a test send.'
    )
  }

  const bam = (inv as {
    bams?: {
      first_name: string
      last_name: string
      email: string
      email_verified_at: string | null
      consent_ap_cc: boolean | null
    }
  }).bams
  const cohort = (inv as {
    cohorts?: {
      po_number: string | null
      program_label: string
      send_mode: string
      bam_copy_mode: 'off' | 'draft' | 'live'
    }
  }).cohorts
  if (!bam) return blocked('bam not found for invoice')
  if (!cohort) return blocked('cohort not found for invoice')
  if (!cohort.po_number) {
    // PO confirmed: 260351 (Robin 7/15). Hard block if cohort PO missing.
    return blocked('cohort.po_number missing — HARD BLOCK, confirm PO before sending')
  }

  // --- P1-1: dryrun guard. Only the Edge Function used to read send_mode, so a
  // single UI click reached accounts.payable@ regardless of the cohort setting.
  // Test sends to an explicitly supplied address are still allowed (that is how
  // the pipeline gets verified) but they never touch AP or invoice_sends.
  if (!testEmail && cohort.send_mode !== 'live') {
    return blocked(
      `cohort.send_mode="${cohort.send_mode}" — live AP send refused. ` +
      'Flip the cohort to live only after the dry-run PDFs have been checked against the ledger.'
    )
  }

  // --- P1-18: sanitize + validate every address before it reaches a header ---
  // Resolved per send, policy first. resolveApAddresses refuses rather than guessing when the
  // setting is unreadable, and its error is surfaced as a block, not swallowed.
  let apTo = ''
  let apCc: string[] = []
  if (!testEmail) {
    const resolved = await resolveApAddresses(admin)
    if (!resolved.ok) return blocked(resolved.error)
    apTo = resolved.to
    apCc = resolved.cc
  }

  const recipient = testEmail ? cleanAddress(testEmail) : apTo
  const recipientProblem = addressProblem(testEmail ? 'test_email' : 'AP recipient', recipient)
  if (recipientProblem) return blocked(recipientProblem)

  const ccList: string[] = []
  let ccNote: string | undefined
  if (!testEmail) {
    for (const [i, raw] of apCc.entries()) {
      const addr = cleanAddress(raw)
      const problem = addressProblem(`CC ${i + 1}`, addr)
      if (problem) return blocked(problem)
      ccList.push(addr)
    }
    // F4: verified + consented only. See lib/bam-cc.ts.
    const ccProblem = bamCcProblem(bam)
    if (ccProblem) {
      ccNote = ccProblem
    } else {
      const bamEmail = cleanAddress(bam.email)
      const formatProblem = addressProblem('bam.email', bamEmail)
      if (formatProblem) {
        ccNote = `BAM not CC'd: ${formatProblem}`
      } else if (!ccList.some(e => e.toLowerCase() === bamEmail.toLowerCase())) {
        ccList.push(bamEmail)
      }
    }
  }

  // --- P0-D: the document must agree with the ledger before anything is sent ---
  const payload = inv.payload_json
  if (!payload || typeof payload !== 'object' || !('invoiceNumber' in (payload as object))) {
    return blocked('invoice has no usable payload_json — regenerate the invoice before sending')
  }
  const ledger = await lookupReimbursement(admin, inv.bam_id, inv.cohort_id, inv.period)
  if (!ledger.ok) return blocked(ledger.error)
  const mismatch = payloadLedgerMismatch((payload as unknown as InvoicePayload).lines, ledger.paidCad)
  if (mismatch) return blocked(mismatch)
  // Matching the ledger is not enough when the ledger is not finished. See
  // undecidedReceiptsProblem: a receipt still in the review queue is money this invoice does
  // not carry, and AP treats what it receives as final.
  if (!testEmail) {
    const undecided = await undecidedReceiptsProblem(admin, inv.bam_id, inv.period)
    if (undecided) return blocked(undecided)
  }

  const period = new Date(inv.period)
  const monthLong = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const subject = apEmailSubject(bam.first_name, bam.last_name, period, inv.invoice_number)
  const bodyText = apEmailBody(monthLong, cohort.program_label, cohort.po_number)
  const filename = invoicePdfFilename(bam.first_name, bam.last_name, period, inv.invoice_number)

  // F1: ONE render+archive path (lib/invoice-pdf.ts). It writes invoices.pdf_key,
  // so SharePoint and the BAM copy later attach the SAME bytes AP received rather
  // than three independent re-renders. Done before claiming the send: a render
  // failure then costs nothing.
  const pdf = await ensureInvoicePdf(admin, {
    id: inv.id,
    period: inv.period,
    invoice_number: inv.invoice_number,
    pdf_key: inv.pdf_key,
    payload_json: payload
  }, filename)
  if (!pdf.ok) return blocked(pdf.error)
  const attachments = [{ filename, content: Buffer.from(pdf.bytes) }]

  const html = textToEmailHtml(bodyText, {
    invoiceNumber: inv.invoice_number,
    bamName: `${bam.first_name} ${bam.last_name}`,
    month: monthLong,
    poNumber: cohort.po_number,
    programLabel: cohort.program_label
  })

  const actualSubject = testEmail ? `[TEST] ${subject}` : subject

  // --- P0-B/P0-C: claim the send BEFORE the external call ---
  let sendRowId: string | null = null
  if (!testEmail) {
    const claim = await claimSend(admin, { invoiceId, target: 'ap', mode: 'live', address: recipient })
    if (!claim.ok) return blocked(`${claim.reason}: ${claim.error}`)
    sendRowId = claim.sendRowId
  }

  const result = await sendEmail({
    to: recipient,
    cc: ccList.length > 0 ? ccList : undefined,
    subject: actualSubject,
    html,
    text: bodyText,
    attachments
  })

  const warnings = [pdf.warning, ccNote].filter((w): w is string => Boolean(w))

  if (!sendRowId) {
    // test send — never recorded, never flips invoice status
    return {
      invoice_id: invoiceId,
      ok: result.sent,
      provider: result.provider,
      error: result.error,
      ...(warnings.length ? { warnings } : {})
    }
  }

  if (!result.sent) {
    const failMark = await markSendFailed(admin, sendRowId, result.error ?? 'send returned sent=false')
    return {
      invoice_id: invoiceId,
      ok: false,
      provider: result.provider,
      error: [result.error ?? 'send failed', failMark.error].filter(Boolean).join(' | '),
      ...(warnings.length ? { warnings } : {})
    }
  }

  const marked = await markSendSucceeded(admin, sendRowId, { messageId: result.messageId })
  if (!marked.error) {
    const { error: statusErr } = await admin
      .from('invoices')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', invoiceId)
    if (statusErr) {
      // The email is out. Say so loudly rather than reporting a clean success.
      return {
        invoice_id: invoiceId,
        ok: true,
        provider: result.provider,
        error: `SENT, but invoices.status update failed: ${statusErr.message} — fix manually before any retry`,
        ...(warnings.length ? { warnings } : {})
      }
    }
  }

  /*
   * THE STUDENT'S OWN COPY OF THE INVOICE.
   *
   * Mirae, 2026-08-13: the student should get the invoice itself when it goes out, not just a
   * notification saying it did. That was already true of batch approval, which calls
   * sendBamCopy, and NOT true of this route, which is the "Send AP" button. All this route did
   * was CC the student on the email addressed to accounts payable, and only when they had
   * separately consented to that. So which document a student received depended on which
   * button Robin pressed.
   *
   * Exactly the call batch-approve makes, with the same mode, so there is one behaviour and not
   * two. sendBamCopy holds all the safety itself: it refuses when the student has never
   * verified their email (P0-4, banking details in the PDF), and it only sends for real when
   * the cohort is on bam_copy_mode=live. Today that is `draft`, so this records the intent and
   * emails nobody until somebody flips it.
   *
   * A FAILED COPY MUST NOT FAIL THE AP SEND. The AP email is already gone at this point and the
   * student being paid does not depend on their copy arriving, so this is a warning on the
   * result, never an error.
   */
  if (!cohort.bam_copy_mode || cohort.bam_copy_mode === 'off') {
    warnings.push('No copy was sent to the BAM: this cohort has BAM copies turned off.')
  } else {
    try {
      const copy = await sendBamCopy({ invoice_id: invoiceId, mode: cohort.bam_copy_mode })
      if (!copy.ok) {
        warnings.push(`No copy was sent to the BAM: ${copy.error}`)
      } else if (cohort.bam_copy_mode !== 'live') {
        warnings.push(
          `The BAM copy was recorded but not emailed, because this cohort is on ` +
          `bam_copy_mode="${cohort.bam_copy_mode}".`
        )
      }
    } catch (e) {
      warnings.push(`No copy was sent to the BAM: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // The student's status board. "Did my invoice actually go out" is the question the portal
  // bell exists to answer without anyone having to ask Robin.
  //
  // Below the test-send return on purpose: a test send goes to the tester, and telling a
  // student their invoice reached accounts payable when it did not is worse than telling them
  // nothing. Below markSendSucceeded for the same reason -- this records what happened, so it
  // must not run where the send did not.
  const notified = await notifyBam({
    bam_id: inv.bam_id,
    type: 'invoice_sent',
    title: `Your ${monthLong} invoice was sent for payment`,
    body: `Invoice ${inv.invoice_number}`,
    link: '/portal/invoices',
    period: inv.period
  })
  if (!notified.ok) warnings.push(`portal notification not recorded: ${notified.error}`)

  return {
    invoice_id: invoiceId,
    ok: true,
    provider: result.provider,
    error: marked.error ? `SENT, but send record update failed: ${marked.error}` : undefined,
    ...(warnings.length ? { warnings } : {})
  }
}

function textToEmailHtml(
  bodyText: string,
  meta: { invoiceNumber: string; bamName: string; month: string; poNumber: string; programLabel: string }
): string {
  const paragraphs = bodyText
    .split('\n')
    .map(line => (line.trim() ? `<p style="margin: 0 0 8px; font-size: 14px; color: #1a1a1a;">${line}</p>` : ''))
    .join('')
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
    ${paragraphs}
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0 12px;" />
    <table style="font-size: 12px; color: #6b7280; border-collapse: collapse;">
      <tr><td style="padding: 2px 8px 2px 0;">Invoice #</td><td>${meta.invoiceNumber}</td></tr>
      <tr><td style="padding: 2px 8px 2px 0;">BAM</td><td>${meta.bamName}</td></tr>
      <tr><td style="padding: 2px 8px 2px 0;">Period</td><td>${meta.month}</td></tr>
      <tr><td style="padding: 2px 8px 2px 0;">Program</td><td>${meta.programLabel}</td></tr>
      <tr><td style="padding: 2px 8px 2px 0;">PO#</td><td>${meta.poNumber}</td></tr>
      <tr><td style="padding: 2px 8px 2px 0;">PDF attached</td><td>Yes</td></tr>
    </table>
  </div>`
}
