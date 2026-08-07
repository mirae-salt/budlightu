/**
 * POST /api/admin/invite  { bam_id }
 * Generates a one-time invite token for a pending BAM, stores the SHA-256
 * hash in `bams.invite_token_hash`, sends the onboarding link via email
 * (Resend free tier), and returns the URL.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { randomBytes, createHash } from 'crypto'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../lib/send-email'
import { appBaseUrl } from '../../../../lib/app-url'

export async function POST(req: NextRequest) {
  const { bam_id } = await req.json()
  if (!bam_id) {
    return NextResponse.json({ ok: false, message: 'bam_id required' }, { status: 400 })
  }

  // --- auth: cookie-based admin check (skip in dev if no session) ---
  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: user } = await supa.auth.getUser()

  const isDev = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
  if (!isDev) {
    if (!user.user) return NextResponse.json({ ok: false }, { status: 401 })
    const role = (user.user.user_metadata as { role?: string }).role
    if (!role || !['program_admin', 'super_admin'].includes(role)) {
      return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })
    }
  }

  // --- look up the BAM ---
  const admin = serviceClient()
  const { data: bam, error: fetchErr } = await admin
    .from('bams')
    .select('id, email, first_name, last_name, status, invite_token_hash')
    .eq('id', bam_id)
    .single()

  if (fetchErr || !bam) {
    return NextResponse.json({ ok: false, message: 'BAM not found' }, { status: 404 })
  }
  if (bam.status !== 'pending') {
    return NextResponse.json(
      { ok: false, message: `BAM is already ${bam.status} — only pending BAMs can receive invites` },
      { status: 409 }
    )
  }

  // --- generate token + store hash ---
  const rawToken = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')

  const { error: updateErr } = await admin
    .from('bams')
    .update({ invite_token_hash: tokenHash })
    .eq('id', bam_id)

  if (updateErr) {
    return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 })
  }

  const appUrl = appBaseUrl()
  const inviteUrl = `${appUrl}/portal/onboarding/${rawToken}`

  // --- send invite email (Resend by default, MS Graph if configured) ---
  const result = await sendEmail({
    to: bam.email,
    subject: `You're invited to Bud Light U — set up your account`,
    html: inviteEmailHtml(bam.first_name, inviteUrl),
    text: `Hi ${bam.first_name},\n\nYou've been selected as a Bud Light U Brand Ambassador! Set up your account here:\n\n${inviteUrl}\n\nThis link is one-time use and tied to your email. If you have any questions, reply to this email or contact your program manager.\n\nBud Light U - Campus Ambassador Program`
  })

  const actorId = user.user?.id ?? 'dev'
  await admin.from('audit_log').insert({
    actor_id: actorId, actor_role: 'admin', entity: 'bams',
    entity_id: bam_id, action: 'invite_sent',
    meta: { email: bam.email, provider: result.provider, sent: result.sent }
  })

  return NextResponse.json({
    ok: true,
    invite_url: inviteUrl,
    bam_email: bam.email,
    bam_name: `${bam.first_name} ${bam.last_name}`,
    email_sent: result.sent,
    email_provider: result.provider,
    email_error: result.error ?? null
  })
}

function inviteEmailHtml(firstName: string, inviteUrl: string): string {
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
