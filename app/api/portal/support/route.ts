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
import { appBaseUrl } from '../../../../lib/app-url'

/**
 * P1-18: the destination comes from env when set, sanitized (a BOM or stray
 * whitespace in an address is invisible and silently misroutes mail). Falls back
 * to Robin's address so an unset env var never means "email nobody".
 */
const ROBIN_FALLBACK = 'robin.graham@ilovesalt.com'
/** The template interpolates a student's own words, so it escapes them. */
function escapeHtml(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

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
  let bamSchool: string | null = null
  let bamCohort: string | null = null
  if (userId) {
    const { data: bamRows, error: bamErr } = await admin.from('bams')
      // school and cohort go in the email: "New BAM question from mirae lee" told Robin
      // who asked and nothing about who they are, so she had to go look them up before she
      // could answer anything.
      .select('id, first_name, last_name, school_id, cohorts(name)')
      .eq('auth_user_id', userId)
      .limit(1)
    if (bamErr) {
      console.error('[portal/support] bam lookup failed for', userId, bamErr.message)
      return NextResponse.json(
        { ok: false, message: 'We could not reach your account just now. Please try again in a moment.' },
        { status: 503 }
      )
    }
    const bam = (bamRows ?? [])[0] as {
      id: string
      first_name: string
      last_name: string
      school_id: string | null
      cohorts?: { name: string } | { name: string }[] | null
    } | undefined
    if (bam) {
      bamId = bam.id
      bamName = `${bam.first_name} ${bam.last_name}`
      bamSchool = bam.school_id ?? null
      const c = Array.isArray(bam.cohorts) ? bam.cohorts[0] : bam.cohorts
      bamCohort = c?.name ?? null
    }
  }

  // Have they asked before? Robin answering a fourth question from the same student
  // should know that, and it is one count rather than a page of history.
  const appUrl = appBaseUrl()
  let priorQuestions = 0
  if (bamId) {
    const { count, error: pqErr } = await admin
      .from('portal_questions')
      .select('id', { count: 'exact', head: true })
      .eq('bam_id', bamId)
    if (pqErr) console.error('[portal/support] prior question count failed:', pqErr.message)
    // Counted BEFORE the insert below, so this really is "how many they asked before this
    // one". The email adds 1 to get the number of the question being read.
    else priorQuestions = count ?? 0
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
    // A plain Reply should reach the student, not bounce off a send-only domain. The body
    // says it does, so it has to.
    replyTo: userEmail,
    subject: `BLU support question from ${bamName}${bamSchool ? ` (${bamSchool})` : ''}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <p style="font-size: 16px; color: #1a1a2e; font-weight: 600; margin: 0 0 4px;">New BAM question</p>
        <p style="font-size: 13px; color: #6b7280; margin: 0 0 16px;">
          ${priorQuestions > 0
            ? `This is question #${priorQuestions + 1} from this BAM.`
            : 'First question from this BAM.'}
        </p>

        <table style="font-size: 14px; color: #374151; line-height: 1.8; border-collapse: collapse;">
          <tr><td style="padding-right: 16px; font-weight: 600;">From</td><td>${escapeHtml(bamName)}</td></tr>
          <tr><td style="padding-right: 16px; font-weight: 600;">Email</td><td><a href="mailto:${escapeHtml(userEmail)}">${escapeHtml(userEmail)}</a></td></tr>
          ${bamSchool ? `<tr><td style="padding-right: 16px; font-weight: 600;">School</td><td>${escapeHtml(bamSchool)}</td></tr>` : ''}
          ${bamCohort ? `<tr><td style="padding-right: 16px; font-weight: 600;">Cohort</td><td>${escapeHtml(bamCohort)}</td></tr>` : ''}
        </table>

        <div style="margin-top: 16px; padding: 16px; background: #f3f4f6; border-radius: 8px; font-size: 14px; color: #1a1a2e; white-space: pre-wrap;">${escapeHtml(question.trim())}</div>

        <p style="margin: 20px 0 0;">
          <a href="${escapeHtml(appUrl)}/admin/questions"
             style="background: #0073cf; color: #ffffff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block;">
            Open in the admin portal
          </a>
        </p>

        <p style="font-size: 13px; color: #6b7280; margin-top: 20px; line-height: 1.5;">
          Reply straight to this email and it goes to ${escapeHtml(bamName)}. Marking it answered
          happens on the Questions page.
        </p>
        <p style="font-size: 12px; color: #9ca3af; margin-top: 16px;">
          You can change how often you get these on the Questions page.
        </p>
      </div>
    `,
    text: [
      'New BAM question',
      priorQuestions > 0 ? `Question #${priorQuestions + 1} from this BAM.` : 'First question from this BAM.',
      '',
      `From:   ${bamName}`,
      `Email:  ${userEmail}`,
      ...(bamSchool ? [`School: ${bamSchool}`] : []),
      ...(bamCohort ? [`Cohort: ${bamCohort}`] : []),
      '',
      question.trim(),
      '',
      `Open in the admin portal: ${appUrl}/admin/questions`,
      `Reply to this email to answer ${bamName} directly.`,
      '',
      'You can change how often you get these on the Questions page.',
      '- Bud Light U'
    ].join('\n')
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
