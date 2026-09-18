/**
 * What the BAM is told when the banking on their file changes.
 *
 * WHY THE STUDENT HEARS ABOUT IT EVEN WHEN THEY ASKED FOR IT
 * ---------------------------------------------------------
 * From 2026-09-17 an admin can raise a banking correction on a BAM's behalf, because
 * waiting for the student to file one from their portal was blocking an invoice on the
 * day it had to go to AP. That is a convenience with a cost: the numbers that decide
 * where someone's pay lands can now move without that person doing anything.
 *
 * The student cannot read their own stored account number back (it is encrypted, and the
 * portal only ever shows the bank name), so they cannot audit this themselves. The only
 * control that works is telling them it happened and giving them the last four digits to
 * check against their own bank.
 *
 * The wording is identical whoever made the change. A student who requested it reads a
 * confirmation; a student who did not reads an alert. Branching on who raised it would
 * mean the alerting case depends on correctly recording who raised it, and that is one
 * more thing to get wrong on the path that matters most.
 *
 * Only the last four digits appear. This text goes to an inbox and to the notification
 * bell, neither of which is a place to put a full account number.
 */

export type BankingChangedInput = {
  firstName: string
  /** Last four digits of the NEW account number, already extracted by the caller. */
  accountLast4: string
  bankName: string
  /** Their invoices page, which is where a question gets raised against an invoice. */
  portalUrl: string
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function bankingChangedEmail(i: BankingChangedInput): { subject: string; html: string; text: string } {
  const subject = 'Your payment details were updated'
  const line = `${i.bankName}, account ending ${i.accountLast4}`

  const text = [
    `Hi ${i.firstName},`,
    '',
    'The banking details we use to pay you have been updated. Payments now go to:',
    '',
    line,
    '',
    'If you asked for this change, there is nothing to do.',
    '',
    'If you did not ask for this, raise a question on your invoice in the portal, or contact',
    'your program manager. Do not reply to this email.',
    '',
    i.portalUrl,
    '',
    'Bud Light U'
  ].join('\n')

  // Explicit white background and near-black text. A dark-mode inbox repaints the body
  // otherwise and the text disappears, which lib/bam-copy-email.ts already had to fix once.
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:10px;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#18181b;">
        <tr><td>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">Hi ${esc(i.firstName)},</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">The banking details we use to pay you have been updated. Payments now go to:</p>
          <p style="margin:0 0 20px;padding:12px 14px;background:#f4f4f5;border-radius:6px;font-size:15px;line-height:1.5;"><strong>${esc(i.bankName)}</strong>, account ending ${esc(i.accountLast4)}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">If you asked for this change, there is nothing to do.</p>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">If you did not ask for this, raise a question on your invoice in the portal, or contact your program manager.</p>
          <p style="margin:0 0 22px;"><a href="${esc(i.portalUrl)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;font-size:14px;font-weight:600;">Go to my invoices</a></p>
          <p style="margin:0;font-size:13px;line-height:1.5;color:#52525b;">This address does not receive replies.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`

  return { subject, html, text }
}
