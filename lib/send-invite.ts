/**
 * Mints an invite token for a pending BAM and emails them the onboarding link.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * There were two ways to get a BAM onto the roster and they behaved differently:
 * the CSV import (`bulk-invite`) created the row AND emailed the invite, while
 * `Add BAM` created the row and sent nothing. Nothing on screen said so, so an admin
 * who added one person by hand watched for an email that was never going to arrive.
 * Robin had also been told, in writing, that adding a BAM "generates + sends invite".
 *
 * `Add BAM` now offers to send too. Rather than copy the token-and-email code into a
 * third place, it lives here and every caller uses it. Two copies of a rule agree
 * right up until someone edits one.
 *
 * WHAT IT DOES NOT DO
 * It does not create, validate or look up the BAM, and it does not decide whether an
 * invite is wanted. Callers do that. It also never throws: an email failure must not
 * undo a roster row that was already written and verified, so the outcome comes back
 * as data for the caller to report.
 */
import { randomBytes, createHash } from 'crypto'
import { sendEmail } from './send-email'
import { appBaseUrl } from './app-url'

/** Statuses that can receive an invite. Anything else is a caller error. */
export const INVITABLE_STATUSES = ['pending'] as const

export type InviteTarget = {
  id: string
  email: string
  first_name: string
  status: string
}

export type InviteResult =
  | {
      ok: true
      /** The one-time link. Show it so an admin can pass it on when email fails. */
      inviteUrl: string
      /** False when the token was stored but the email did not go out. */
      emailSent: boolean
      emailProvider: string
      emailError: string | null
    }
  | { ok: false; reason: 'not_invitable' | 'token_write_failed'; message: string }

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Db = any

/**
 * Stores a fresh token hash on the BAM and emails the link.
 *
 * The token is 32 random bytes; only its SHA-256 hash is stored, so the raw value
 * exists in the email and this return value and nowhere else. Minting a new one
 * invalidates any previous link for that BAM, which is what makes re-inviting safe.
 */
export async function sendBamInvite(db: Db, bam: InviteTarget): Promise<InviteResult> {
  if (!(INVITABLE_STATUSES as readonly string[]).includes(bam.status)) {
    return {
      ok: false,
      reason: 'not_invitable',
      message: `${bam.email} is already ${bam.status}. Only pending BAMs can be invited. ` +
        'Set their status to Pending on the roster if you need to re-invite them.'
    }
  }

  const rawToken = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')

  const { data: updated, error: updateErr } = await db
    .from('bams')
    .update({ invite_token_hash: tokenHash })
    .eq('id', bam.id)
    .select('id')

  // Read-back: an update that matches zero rows reports success, and an invite whose
  // token was never stored is a link that will be refused when it is clicked.
  if (updateErr || !updated || updated.length !== 1) {
    return {
      ok: false,
      reason: 'token_write_failed',
      message: `Could not store the invite token for ${bam.email}` +
        (updateErr ? `: ${updateErr.message}` : ' (no row was updated)') +
        '. No email was sent.'
    }
  }

  const inviteUrl = `${appBaseUrl()}/portal/onboarding/${rawToken}`

  const result = await sendEmail({
    to: bam.email,
    subject: `You're invited to Bud Light U — set up your account`,
    html: inviteEmailHtml(bam.first_name, inviteUrl),
    text: `Hi ${bam.first_name},\n\nYou've been selected as a Bud Light U Brand Ambassador! Set up your account here:\n\n${inviteUrl}\n\nThis link is one-time use and tied to your email. If you have any questions, reply to this email or contact your program manager.\n\nBud Light U - Campus Ambassador Program`
  })

  return {
    ok: true,
    inviteUrl,
    emailSent: result.sent,
    emailProvider: result.provider,
    emailError: result.error ?? null
  }
}

export function inviteEmailHtml(firstName: string, inviteUrl: string): string {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <h2 style="color: #001a3e; margin: 0;">Bud Light U</h2>
      <p style="color: #6b7280; font-size: 13px; margin: 4px 0 0;">Campus Ambassador Program</p>
    </div>

    <p style="font-size: 16px; color: #1a1a1a;">Hi ${firstName},</p>

    <p style="font-size: 15px; color: #333; line-height: 1.6;">
      You've been selected as a Bud Light U Brand Ambassador! To get started,
      set up your account by clicking the link below. You'll enter your personal
      and banking details so we can process your monthly payments.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 32px auto;">
      <tr>
        <td align="center" bgcolor="#0073cf" style="border-radius: 8px;">
          <a href="${inviteUrl}"
             style="background: #0073cf; color: #ffffff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
            Set up my account
          </a>
        </td>
      </tr>
    </table>

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      If the button above does not work, copy and paste this link into your browser:
    </p>
    <p style="font-size: 12px; line-height: 1.5; word-break: break-all;">
      <a href="${inviteUrl}" style="color: #0073cf;">${inviteUrl}</a>
    </p>

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      This link is one-time use and tied to your email. If you have any questions,
      reply to this email or contact your program manager.
    </p>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;" />
    <p style="font-size: 11px; color: #9ca3af; text-align: center;">
      Bud Light U · Campus Ambassador Program · Powered by Salt XC
    </p>
  </div>`
}
