/**
 * Telling a BAM that their published invoice changed.
 *
 * WHY THIS HAS TO EXIST
 * ---------------------
 * A correction after release does NOT restart the 24-hour window (0036): the send day is
 * fixed, so corrections happen inside the first window. The row on /portal/invoices says
 * "Updated, please check again", which is only true for a student who happens to open the
 * portal again, and they now have LESS time on the new figure rather than more. Without this, the sequence is:
 *
 *   we email them a figure -> we change the figure -> we say nothing -> we send it
 *
 * and "they had 24 hours to object" becomes a claim about a number they were never shown.
 * The window is a legal instrument, so the notice has to travel the same way the first one
 * did: an email with the corrected PDF, plus the portal notification.
 *
 * ONLY WHEN THE MONEY MOVED
 * -------------------------
 * `upsertDraftInvoice` runs on every receipt decision and rewrites the payload whether or
 * not the total changed. Mailing a student each time an admin touches one of their
 * receipts is how a mailbox gets muted, so the caller passes the before and after totals
 * and an unchanged figure notifies nobody.
 *
 * FAILURE IS REPORTED, NEVER THROWN
 * ---------------------------------
 * The callers are a background rebuild and an admin's edit. Neither should fail because an
 * email did not go: the revision itself is already recorded. The result says what happened
 * so the caller can surface it, because a correction nobody was told about is the case
 * this whole file exists to prevent.
 */
import { ensureInvoicePdf } from './invoice-pdf'
import { sendEmail } from './send-email'
import { notifyBam } from './notify-bam'
import { sendEligibleAt } from './business-days'

/*
 * The array form, not maybeSingle().
 *
 * This asked for `.maybeSingle()` at first and broke eight of the line editor's tests,
 * because that is not the client shape this codebase's callers (or their test doubles)
 * implement -- lib/draft-invoice says so in as many words. A helper that requires a richer
 * client than its callers have is a helper that only works in production.
 */
type Db = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: unknown) => Promise<{ data: unknown[] | null; error: { message: string } | null }>
    }
  }
}

export type RevisedNoticeResult = {
  /** True when nothing needed sending: the total did not move, or it was never published. */
  skipped: boolean
  emailed: boolean
  notified: boolean
  note: string | null
}

const quiet = (note: string): RevisedNoticeResult => ({ skipped: true, emailed: false, notified: false, note })

/** Same wording as the release email, so the two read as one conversation. */
function deadlineLabel(d: Date): string {
  return d.toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  }) + ' Eastern'
}

export async function notifyInvoiceRevised(
  db: Db,
  invoiceId: string,
  opts: { previousTotal: number | null; newTotal: number | null }
): Promise<RevisedNoticeResult> {
  const { previousTotal, newTotal } = opts

  // Both null happens on an invoice with no usable payload; equal means an admin touched
  // something that was not the money.
  if (previousTotal === newTotal) return quiet('the total did not change')

  const { data, error } = await db.from('invoices')
    .select('id, bam_id, period, invoice_number, status, released_at, revised_at, pdf_key, payload_json, bams(first_name, email), cohorts(send_mode)')
    .eq('id', invoiceId)
  if (error) return { skipped: false, emailed: false, notified: false, note: `could not read the invoice: ${error.message}` }

  const inv = ((data ?? [])[0] ?? null) as {
    id: string; bam_id: string; period: string; invoice_number: string | null
    status: string; released_at: string | null; revised_at: string | null
    pdf_key: string | null; payload_json: unknown
    bams?: { first_name?: string | null; email?: string | null } | Array<{ first_name?: string | null; email?: string | null }> | null
    cohorts?: { send_mode?: string | null } | Array<{ send_mode?: string | null }> | null
  } | null
  if (!inv) return quiet('invoice not found')

  // Nothing to re-tell if they were never told in the first place. An unreleased draft
  // changes all month; that is what drafting is.
  if (!inv.released_at) return quiet('never released, so there is nothing to correct for them')

  const bam = Array.isArray(inv.bams) ? inv.bams[0] : inv.bams
  const sendMode = (Array.isArray(inv.cohorts) ? inv.cohorts[0] : inv.cohorts)?.send_mode ?? 'dryrun'

  // The ORIGINAL deadline. A correction does not buy anyone more time (0036), so this
  // notice has to state the same time the first email did, or it promises a day that the
  // send gate will not honour.
  const deadline = deadlineLabel(sendEligibleAt(new Date(inv.released_at)))

  const monthLabel = new Date(inv.period + 'T00:00:00Z')
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const wasLabel = typeof previousTotal === 'number' ? `$${previousTotal.toFixed(2)}` : null
  const nowLabel = typeof newTotal === 'number' ? `$${newTotal.toFixed(2)}` : null

  const notified = await notifyBam({
    bam_id: inv.bam_id,
    type: 'invoice_review',
    title: 'Your invoice changed',
    body: `Invoice ${inv.invoice_number ?? ''} for ${monthLabel} was corrected`
      + `${wasLabel && nowLabel ? ` from ${wasLabel} to ${nowLabel}` : ''}. `
      + `Please look at it again. The deadline has not changed: if nothing comes back from you by ${deadline}, we send it as it stands.`,
    link: '/portal/invoices',
    period: inv.period
  })

  if (sendMode !== 'live') {
    return { skipped: false, emailed: false, notified: notified.ok, note: `cohort is in ${sendMode} mode, so no email was sent` }
  }
  if (!bam?.email) {
    return { skipped: false, emailed: false, notified: notified.ok, note: 'no email on file' }
  }
  if (!inv.payload_json) {
    return { skipped: false, emailed: false, notified: notified.ok, note: 'no payload, so no PDF could be attached' }
  }

  // The corrected document, not the old one: pdf_key was cleared by whoever revised this,
  // so this renders and stores the new bytes, and AP later receives the same file.
  const filename = `${inv.invoice_number}.pdf`
  const pdf = await ensureInvoicePdf(
    db as never,
    { id: inv.id, period: inv.period, invoice_number: inv.invoice_number as string, pdf_key: inv.pdf_key, payload_json: inv.payload_json },
    filename
  )
  if (!pdf.ok) {
    return { skipped: false, emailed: false, notified: notified.ok, note: `could not render the corrected PDF: ${pdf.error}` }
  }

  const sent = await sendEmail({
    to: bam.email,
    subject: `Your Bud Light U invoice for ${monthLabel} has changed`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <p style="font-size: 16px; color: #1a1a2e;">Hi ${bam.first_name ?? 'there'},</p>
        <p style="font-size: 14px; color: #374151; line-height: 1.6;">
          We corrected your invoice for <strong>${monthLabel}</strong>${wasLabel && nowLabel
            ? `. The total went from <strong>${wasLabel}</strong> to <strong>${nowLabel}</strong>` : ''}.
          The corrected copy is attached, and it is on your portal.
        </p>
        <p style="font-size: 14px; color: #374151; line-height: 1.6;">
          Please check it again. The deadline has not changed. If anything is wrong,
          tell us by <strong>${deadline}</strong> on the
          <a href="${process.env.NEXT_PUBLIC_APP_URL ?? ''}/portal/invoices" style="color: #0073cf;">My invoices</a>
          page.
        </p>
        <p style="font-size: 14px; color: #374151; line-height: 1.6;">
          If we do not hear from you by then, we send it to accounts payable as it stands.
        </p>
        <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">Bud Light U</p>
      </div>
    `,
    attachments: [{ filename, content: Buffer.from(pdf.bytes) }]
  })

  return {
    skipped: false,
    emailed: sent.sent,
    notified: notified.ok,
    note: sent.sent ? null : `email failed: ${sent.error}`
  }
}
