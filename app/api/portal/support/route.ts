/**
 * POST /api/portal/support  { question }
 * Inserts a support question and emails Robin.
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  QUESTION_NOTIFY_KEY,
  parseQuestionNotify,
  recipientsForArrival
} from '../../../../lib/question-notify'
import { getRole, isAdminRole } from '../../../../lib/auth-claims'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { getSessionUser, isDevBypass } from '../../../../lib/admin-auth'
import { sendEmail } from '../../../../lib/send-email'
import { notifyAdmin } from '../../../../lib/notify-admin'
import { envAddress } from '../../../../lib/sanitize'

/**
 * P1-18: the destination comes from env when set, sanitized (a BOM or stray
 * whitespace in an address is invisible and silently misroutes mail). Falls back
 * to Robin's address so an unset env var never means "email nobody".
 */
const ROBIN_FALLBACK = 'robin.graham@ilovesalt.com'
function supportRecipient(): string {
  return envAddress('SUPPORT_NOTIFY_EMAIL') ?? envAddress('ROBIN_EMAIL') ?? ROBIN_FALLBACK
}

export async function POST(req: NextRequest) {
  // The dev bypass now requires BOTH NODE_ENV=development AND an explicit opt-in
  // flag, matching middleware and lib/admin-auth. `NODE_ENV === 'development'`
  // alone skipped authentication on any deploy where NODE_ENV was wrong.
  const devBypass = isDevBypass()

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }

  const question = (body as { question?: unknown } | null)?.question
  if (typeof question !== 'string' || question.trim().length < 5) {
    return NextResponse.json({ ok: false, message: 'Question is too short' }, { status: 400 })
  }

  let userId: string | null = null
  let userEmail = ''

  if (!devBypass) {
    // getSessionUser fails CLOSED when the Supabase env vars are missing, rather
    // than throwing a 500 from a non-null assertion.
    const session = await getSessionUser()
    if (!session.ok) {
      return NextResponse.json({ ok: false, message: session.message }, { status: session.status })
    }
    userId = session.user.id
    userEmail = session.user.email ?? ''
  } else {
    userEmail = 'demo.bam@school.edu'
  }

  let admin
  try {
    admin = serviceClient()
  } catch {
    console.error('[portal/support] service client unavailable')
    return NextResponse.json(
      { ok: false, message: 'Support is temporarily unavailable. Please try again shortly.' },
      { status: 503 }
    )
  }

  // Look up BAM details. P0-H: inspect the error rather than treating a failed
  // lookup as "Unknown BAM", which would silently detach the question from the
  // student who asked it.
  let bamName = 'Unknown BAM'
  let bamId: string | null = null
  if (userId) {
    const { data: bamRows, error: bamErr } = await admin.from('bams')
      .select('id, first_name, last_name')
      .eq('auth_user_id', userId)
      .limit(1)
    if (bamErr) {
      console.error('[portal/support] bam lookup failed for', userId, bamErr.message)
      return NextResponse.json(
        { ok: false, message: 'We could not reach your account just now. Please try again in a moment.' },
        { status: 503 }
      )
    }
    const bam = (bamRows ?? [])[0] as { id: string; first_name: string; last_name: string } | undefined
    if (bam) {
      bamId = bam.id
      bamName = `${bam.first_name} ${bam.last_name}`
    }
  }

  // Insert question into DB
  const { data: inserted, error: insErr } = await admin.from('portal_questions').insert({
    bam_id: bamId,
    question: question.trim(),
  }).select('id')

  if (insErr) {
    return NextResponse.json({ ok: false, message: insErr.message }, { status: 500 })
  }
  const questionId = ((inserted ?? [])[0] as { id?: string } | undefined)?.id ?? null

  // How often Robin wants these is HER setting, not ours (lib/question-notify.ts).
  // This used to email on every question, which is right at three a month and wrong
  // during onboarding week with 58 BAMs.
  //
  // A failed read sends anyway: an extra email is cheap, a student's question sitting
  // unanswered is not. That is the opposite of how maintenance mode fails, on purpose.
  const { data: notifyRow, error: notifyErr } = await admin
    .from('policy').select('value_json').eq('key', QUESTION_NOTIFY_KEY).limit(1)
  if (notifyErr) {
    console.error('[portal/support] notify setting unreadable, emailing anyway:', notifyErr.message)
  }
  const notify = notifyErr
    ? null
    : parseQuestionNotify(((notifyRow ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)

  // EVERY admin who wants each question, not one hardcoded address.
  //
  // This used to mail `supportRecipient()`, a single address falling back to Robin, so
  // Robin got every question and no other admin got any -- which is why Mirae never saw
  // one. And the frequency setting was global, so one admin turning it down turned it
  // down for everybody. Both are per-admin now.
  const { data: adminList, error: adminErr } = await admin.auth.admin.listUsers({ perPage: 1000 })
  if (adminErr) console.error('[portal/support] admin list unreadable:', adminErr.message)
  const adminEmails = (adminList?.users ?? [])
    .filter(u => isAdminRole(getRole(u)))
    .map(u => (u.email ?? '').trim())
    .filter(Boolean)

  // Falling back to the old single recipient rather than to nobody: if the admin list
  // cannot be read, a question still reaches a human.
  const recipients = adminEmails.length > 0
    ? recipientsForArrival(notify, adminEmails)
    : [supportRecipient()]
  const emailNow = recipients.length > 0

  // Email Robin. P1-12: the outcome is captured instead of swallowed by
  // `.catch(() => {})`, so a silent delivery failure is at least visible.
  const emailError: string | null = !emailNow ? null : await sendEmail({
    to: recipients,
    subject: `BLU support question from ${bamName}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <p style="font-size: 16px; color: #1a1a2e; font-weight: 600;">New BAM question</p>
        <table style="font-size: 14px; color: #374151; line-height: 1.8; border-collapse: collapse;">
          <tr><td style="padding-right: 16px; font-weight: 600;">From</td><td>${bamName}</td></tr>
          <tr><td style="padding-right: 16px; font-weight: 600;">Email</td><td>${userEmail}</td></tr>
        </table>
        <div style="margin-top: 16px; padding: 16px; background: #f3f4f6; border-radius: 8px; font-size: 14px; color: #1a1a2e; white-space: pre-wrap;">${question.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}</div>
        <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">Reply directly to the BAM at <a href="mailto:${userEmail}">${userEmail}</a>.</p>
        <p style="font-size: 12px; color: #9ca3af; margin-top: 16px;">BLU Portal</p>
      </div>
    `,
    text: `New BAM question\n\nFrom: ${bamName} (${userEmail})\n\n${question.trim()}\n\nReply to: ${userEmail}\n\n- BLU Portal`
  }).then(
    () => null,
    (e: unknown) => {
      // The question IS saved in portal_questions, so this is not a data loss;
      // it means Robin will see it in the dashboard rather than her inbox.
      console.error('[portal/support] email to Robin failed:', (e as Error).message)
      return (e as Error).message
    }
  )

  // Stamp notified_at when the mail actually went out, so the daily digest does not
  // send it a second time. Only on success: stamping a failed send would lose the
  // question from both paths at once, which is the one outcome worth avoiding here.
  if (emailNow && !emailError && questionId) {
    const { error: stampErr } = await admin
      .from('portal_questions')
      .update({ notified_at: new Date().toISOString() })
      .eq('id', questionId)
    if (stampErr) {
      // Not fatal: the question is saved and Robin already has the email. The cost is
      // that tomorrow's digest may repeat it, which is the harmless direction.
      console.error('[portal/support] could not stamp notified_at:', stampErr.message)
    }
  }

  // Admin notification. P1-17: the result is now checked, so a dropped
  // notification is visible in logs instead of vanishing.
  const notif = await notifyAdmin({
    type: 'support_question',
    title: `Support question from ${bamName}`,
    body: question.trim().slice(0, 120),
    bam_id: bamId ?? undefined,
    link: '/admin/questions'
  })
  if (!notif.ok) {
    console.error('[portal/support] admin notification not recorded:', notif.error)
  }

  // The student's question is stored either way; `delivered` tells the caller
  // whether the out-of-band alerts also landed.
  return NextResponse.json({
    ok: true,
    delivered: { email: emailError === null, notification: notif.ok }
  })
}
