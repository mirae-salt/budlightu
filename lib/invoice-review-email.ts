/**
 * The two emails a BAM gets during their 24-hour review window (0035, 0036).
 *
 * WHY THESE MOVED OUT OF THE ROUTES
 * ---------------------------------
 * Both were written inline in their handlers as ad-hoc HTML, which lost everything
 * lib/bam-copy-email.ts had already settled: the explicit white background (without one,
 * near-black body text sits on whatever a dark-mode inbox paints behind it), the escaped
 * name (an ampersand in a surname renders as a broken entity), the plain-text alternative,
 * and the header and footer that make it look like it came from this program. Mirae, on
 * seeing the first one arrive: "템플릿(디자인 적용)도 없는듯". She was right.
 *
 * Pure, like its neighbour, so the exact bytes a student receives can be read in a test
 * rather than inferred from the code that sends them.
 */
import { escapeHtml } from './bam-copy-email'

export type ReviewEmail = { subject: string; text: string; html: string }

export type ReleaseEmailInput = {
  firstName: string
  /** Long month and year, e.g. "September 2026". */
  month: string
  invoiceNumber: string
  /** Already formatted for a person, with its timezone named. */
  deadline: string
  portalUrl: string
  /** The invoice total, or null when the payload had no usable figure. */
  total: number | null
  attached: boolean
}

export type RevisedEmailInput = ReleaseEmailInput & {
  previousTotal: number | null
}

const money = (n: number | null): string | null => (typeof n === 'number' ? `$${n.toFixed(2)}` : null)

/**
 * The shell every one of these shares, so the two emails cannot drift apart in look the
 * way the two BAM-copy templates once did.
 */
function shell(body: string, portalUrl: string, cta: string): string {
  return `
  <div style="background: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <h2 style="color: #001a3e; margin: 0;">Bud Light U</h2>
      <p style="color: #6b7280; font-size: 13px; margin: 4px 0 0;">Campus Ambassador Program</p>
    </div>
${body}
    <div style="text-align: center; margin: 32px 0;">
      <a href="${escapeHtml(portalUrl)}"
         style="background: #0073cf; color: #ffffff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
        ${escapeHtml(cta)}
      </a>
    </div>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;" />
    <p style="font-size: 11px; color: #9ca3af; text-align: center;">
      Bud Light U · Campus Ambassador Program · Powered by Salt XC
    </p>
  </div>`
}

/** Published for review. Their 24 hours start here. */
export function invoiceReleaseEmail(input: ReleaseEmailInput): ReviewEmail {
  const { firstName, month, invoiceNumber, deadline, portalUrl, total, attached } = input
  const totalLabel = money(total)

  const subject = `Please check your ${month} invoice`

  const lines = [
    `Hi ${firstName},`,
    '',
    attached
      ? `Your ${month} invoice (${invoiceNumber}) is attached, and it is on your portal.`
      : `Your ${month} invoice (${invoiceNumber}) is ready on your portal.`,
    ...(totalLabel ? ['', `Total: ${totalLabel}`] : []),
    '',
    `Please look it over. If anything is wrong, tell us by ${deadline} on the My invoices page.`,
    'There is a button there to send us a message about it.',
    '',
    'If we do not hear from you by then, we send it to accounts payable as it stands.',
    '',
    portalUrl,
    '',
    'Bud Light U'
  ]

  const body = `
    <p style="font-size: 16px; color: #1a1a1a;">Hi ${escapeHtml(firstName)},</p>

    <p style="font-size: 15px; color: #333; line-height: 1.6;">
      Your ${escapeHtml(month)} invoice (${escapeHtml(invoiceNumber)}) is
      ${attached ? 'attached' : 'ready'}, and it is on your portal.
    </p>
${totalLabel ? `
    <p style="font-size: 15px; color: #333; line-height: 1.6;">
      Total: <strong>${escapeHtml(totalLabel)}</strong>
    </p>` : ''}
    <p style="font-size: 15px; color: #333; line-height: 1.6;">
      Please look it over. If anything is wrong, tell us by <strong>${escapeHtml(deadline)}</strong>
      using the button on your invoice.
    </p>

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      If we do not hear from you by then, we send it to accounts payable as it stands.
    </p>
`

  return { subject, text: lines.join('\n'), html: shell(body, portalUrl, 'Check your invoice') }
}

/**
 * The figure moved after they were shown it.
 *
 * It says the deadline has not changed, because it has not: a correction does not restart
 * the window (0036), so a message implying more time would promise something the send gate
 * will not honour.
 */
export function invoiceRevisedEmail(input: RevisedEmailInput): ReviewEmail {
  const { firstName, month, invoiceNumber, deadline, portalUrl, total, previousTotal, attached } = input
  const was = money(previousTotal)
  const now = money(total)
  const change = was && now ? `The total went from ${was} to ${now}.` : 'The amount changed.'

  const subject = `Your ${month} invoice has changed`

  const lines = [
    `Hi ${firstName},`,
    '',
    `We corrected your ${month} invoice (${invoiceNumber}). ${change}`,
    attached ? 'The corrected copy is attached, and it is on your portal.' : 'It is on your portal.',
    '',
    `Please check it again. The deadline has not changed: if anything is wrong, tell us by ${deadline}.`,
    '',
    'If we do not hear from you by then, we send it to accounts payable as it stands.',
    '',
    portalUrl,
    '',
    'Bud Light U'
  ]

  const body = `
    <p style="font-size: 16px; color: #1a1a1a;">Hi ${escapeHtml(firstName)},</p>

    <p style="font-size: 15px; color: #333; line-height: 1.6;">
      We corrected your ${escapeHtml(month)} invoice (${escapeHtml(invoiceNumber)}).
      ${escapeHtml(change)}
    </p>

    <p style="font-size: 15px; color: #333; line-height: 1.6;">
      ${attached ? 'The corrected copy is attached, and it is on your portal.' : 'It is on your portal.'}
      Please check it again. <strong>The deadline has not changed.</strong> If anything is
      wrong, tell us by <strong>${escapeHtml(deadline)}</strong>.
    </p>

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      If we do not hear from you by then, we send it to accounts payable as it stands.
    </p>
`

  return { subject, text: lines.join('\n'), html: shell(body, portalUrl, 'Check the corrected invoice') }
}
