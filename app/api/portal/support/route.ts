/**
 * POST /api/portal/support  { question }
 *
 * STARTS a thread. Replying in one is /api/portal/questions POST. Both hand off to
 * lib/question-alert.ts, which is what decides who is emailed and hands the question to the
 * daily digest; that used to live here inline and the follow-up route had no equivalent, so
 * replying in a thread notified nobody at all.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { getSessionUser, isDevBypass } from '../../../../lib/admin-auth'
import { devBypassBam } from '../../../../lib/dev-bam'
import { appBaseUrl } from '../../../../lib/app-url'
import { alertAdminsAboutQuestion } from '../../../../lib/question-alert'

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

  // Under the dev bypass, act as the SAME test BAM every other portal route acts as. Without this
  // the question was inserted with bam_id null, which orphans it: /api/portal/questions filters by
  // the caller's own bam_id, so nobody could ever be shown it. Found 2026-08-13 by submitting one.
  if (devBypass) {
    const dev = await devBypassBam(admin)
    if (dev) {
      bamId = dev.id
      bamName = dev.first_name ?? 'Test BAM'
      userEmail = dev.email ?? userEmail
    }
  }
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

  /*
   * THE STUDENT'S OWN QUESTION, as the thread's first message.
   *
   * Migration 0027 backfilled this for every row that existed at the time, but backfilling ran
   * once. Every question asked THROUGH THIS ROUTE afterward never got a matching 'bam' message,
   * so /portal/support's thread view (QuestionHistory.tsx) only takes its fallback path
   * (show `question`/`answer` directly) while `messages` is empty. The moment an admin replies
   * and the reply is appended as a message, `messages.length` becomes 1 and the fallback stops
   * firing, so the thread renders the admin's answer with the student's own question gone.
   *
   * Found 2026-08-14 by Robin, testing her own test account: she asked a question, it got
   * answered, and her own question disappeared from the screen.
   *
   * Not fatal to the request if it fails: the question is already saved in portal_questions,
   * and app/api/admin/questions/route.ts falls back to that column when messages cannot be
   * read, so a lost message here degrades rather than loses the record.
   */
  if (questionId) {
    const { error: msgErr } = await admin.from('portal_question_messages').insert({
      question_id: questionId,
      author: 'bam',
      body: question.trim()
    })
    if (msgErr) console.error('[portal/support] could not add the question as a thread message:', msgErr.message)
  }

  /*
   * Everything that follows -- who is emailed, the email itself, the notified_at handover to
   * the daily digest, and the in-app admin notification -- moved to lib/question-alert.ts so
   * that replying in a thread does the same thing.
   *
   * It did not. A follow-up saved the message and told nobody, and because notified_at was
   * still stamped from this question, the digest skipped it too. Leaving this block here and
   * writing a second one for follow-ups is how the two drift.
   */
  const alert = await alertAdminsAboutQuestion(admin, {
    kind: 'new',
    questionId,
    bamId,
    bamName,
    bamEmail: userEmail,
    bamSchool,
    bamCohort,
    message: question.trim(),
    priorQuestions,
    appUrl
  })

  // The student's question is stored either way; `delivered` tells the caller
  // whether the out-of-band alerts also landed.
  return NextResponse.json({
    ok: true,
    delivered: { email: alert.emailError === null, notification: alert.notified }
  })
}

