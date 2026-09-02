/**
 * The email a BAM gets with their own copy of an invoice.
 *
 * There used to be two of these. The one that actually went out lived in the
 * sendBamCopy Edge Function and was plain text wrapped in a <pre>; a second,
 * branded HTML version sat in app/api/admin/send-bam-copy/route.ts with no
 * caller at all. Anyone asked to change "the BAM copy email" had even odds of
 * editing the dead one. That route is gone and this is the only copy.
 *
 * Pure, so the exact bytes a student receives can be rendered and read in a
 * test rather than inferred from the code that sends them.
 */

/** HTML-escape. The name comes from the roster, so it is not ours to trust with
 *  markup: an ampersand in a surname would otherwise render as a broken entity. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type BamCopyEmail = { subject: string; text: string; html: string }

/**
 * @param firstName  the BAM's first name, as stored
 * @param month      long month name, e.g. "September"
 * @param invoiceNumber e.g. "INV-LG1"
 * @param portalUrl  deep link to the student's own invoice list
 * @param attached   whether a PDF is actually attached to this message
 */
export function bamCopyEmail(
  firstName: string,
  month: string,
  invoiceNumber: string,
  portalUrl: string,
  attached: boolean
): BamCopyEmail {
  // No em dash. The old subject was "Your Bud Light U invoice — September".
  const subject = `Your ${month} invoice is ready`

  /*
   * SHORT ON PURPOSE. An earlier version said the invoice was attached, that AP
   * had been notified, and that payment would arrive on net-15 terms by direct
   * deposit. Two of those the student cannot act on, and the third is a promise
   * we do not control: the signed BAM contract says Net 30, so quoting net-15
   * here would tell a student a payment date nobody agreed to.
   */
  const lines = [
    `Hi ${firstName},`,
    '',
    attached
      ? `Your ${month} invoice (${invoiceNumber}) is attached.`
      : `Your ${month} invoice (${invoiceNumber}) is ready.`,
    '',
    // The old plain-text version told students to use "the support page in your
    // portal" and then gave no address at all.
    'You can see it any time in your portal:',
    portalUrl,
    '',
    'Questions? Ask on the support page there.',
    '',
    'Bud Light U'
  ]
  const text = lines.join('\n')

  const safeName = escapeHtml(firstName)
  const safeNumber = escapeHtml(invoiceNumber)
  const safeUrl = escapeHtml(portalUrl)

  /*
   * The white background is explicit, and so is every text colour against it.
   * Rendered without one, the near-black body text sat on whatever the client
   * painted behind it, which in a dark-mode inbox is near-black as well. This
   * was visible the moment the HTML was opened in a dark browser and invisible
   * from reading the code.
   */
  const html = `
  <div style="background: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <h2 style="color: #001a3e; margin: 0;">Bud Light U</h2>
      <p style="color: #6b7280; font-size: 13px; margin: 4px 0 0;">Campus Ambassador Program</p>
    </div>

    <p style="font-size: 16px; color: #1a1a1a;">Hi ${safeName},</p>

    <p style="font-size: 15px; color: #333; line-height: 1.6;">
      Your ${escapeHtml(month)} invoice (${safeNumber}) is ${attached ? 'attached' : 'ready'}.
    </p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${safeUrl}"
         style="background: #0073cf; color: #ffffff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
        View it in your portal
      </a>
    </div>

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      Questions? Ask on the support page in your portal.
    </p>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;" />
    <p style="font-size: 11px; color: #9ca3af; text-align: center;">
      Bud Light U · Campus Ambassador Program · Powered by Salt XC
    </p>
  </div>`

  return { subject, text, html }
}
