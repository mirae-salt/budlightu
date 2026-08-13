/**
 * GET /api/portal/questions — the signed-in BAM's own questions, with any answer.
 *
 * The portal could take a question and then showed the student nothing: no history, no answer, no
 * evidence it had been received. The reply arrived by email and that was the only copy. So a student
 * who deleted the mail, or who asked twice because they were not sure the first one landed, had no
 * way to check.
 *
 * SCOPED TO THEIR OWN ROWS, resolved from the session rather than from anything in the request. A
 * bam_id in a query string is how one student reads another student's support history.
 *
 * Reads the existing columns on `portal_questions`, so this needs no migration. It is therefore one
 * question and one answer per row, not a multi-message thread; a real back-and-forth wants a
 * `portal_question_messages` child table, which is the next step and is written up in
 * HANDOFF-2026-08-13.md section 1.3.
 */
import { NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { getSessionUser, isDevBypass } from '../../../../lib/admin-auth'
import { devBypassBam } from '../../../../lib/dev-bam'

export async function GET() {
  const devBypass = isDevBypass()

  let userId: string | null = null
  if (!devBypass) {
    const session = await getSessionUser()
    if (!session.ok) {
      return NextResponse.json({ ok: false, message: session.message }, { status: session.status })
    }
    userId = session.user.id
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  // Resolve the roster row first. Same dev-bypass shape as /api/portal/reminders: an is_test row
  // only, so the student view can be opened in dev without a real OTP.
  let bamId: string | null = null
  if (devBypass) {
    bamId = (await devBypassBam(db))?.id ?? null
  } else {
    const { data, error } = await db
      .from('bams').select('id').eq('auth_user_id', userId).limit(1)
    if (error) {
      console.error('[portal/questions] bam lookup failed:', error.message)
      return NextResponse.json(
        { ok: false, message: 'We could not reach your account just now.' },
        { status: 503 }
      )
    }
    bamId = ((data ?? [])[0] as { id: string } | undefined)?.id ?? null
  }

  // An admin browsing the portal without a roster row. Not an error, just nothing to show.
  if (!bamId) return NextResponse.json({ ok: true, questions: [] })

  // The THREAD, not one question and one answer. portal_question_messages holds every message with
  // its own author and timestamp (migration 0027); `question` and `answer` are kept in sync so
  // anything still reading them works, but the messages are what render.
  const { data, error } = await db
    .from('portal_questions')
    .select('id, question, answer, answered_at, submitted_at, portal_question_messages(id, author, body, created_at)')
    .eq('bam_id', bamId)
    .order('submitted_at', { ascending: false })
    .limit(50)

  if (error) {
    // Unknown is not none. Rendering an empty list here would tell a student their question was
    // never received, which is the one wrong thing this page can say.
    console.error('[portal/questions] read failed:', error.message)
    return NextResponse.json(
      { ok: false, message: 'We could not load your questions just now.' },
      { status: 503 }
    )
  }

  // Messages oldest first. The join does not guarantee an order, and a thread that renders the reply
  // above the question is not a thread.
  const questions = (data ?? []).map(q => {
    const raw = (q as { portal_question_messages?: Array<{ created_at: string }> }).portal_question_messages
    const messages = Array.isArray(raw)
      ? [...raw].sort((a, b) => a.created_at.localeCompare(b.created_at))
      : []
    return { ...q, messages, portal_question_messages: undefined }
  })

  return NextResponse.json({ ok: true, questions })
}

/**
 * POST /api/portal/questions  { question_id, body }
 *
 * A follow-up on an existing thread. Separate from /api/portal/support, which STARTS one: that route
 * notifies admins about a new question, and a follow-up on a thread Robin is already in is a different
 * event. Reopens the thread, because a new message from the student means it is waiting again.
 */
export async function POST(req: Request) {
  const devBypass = isDevBypass()

  let userId: string | null = null
  if (!devBypass) {
    const session = await getSessionUser()
    if (!session.ok) {
      return NextResponse.json({ ok: false, message: session.message }, { status: session.status })
    }
    userId = session.user.id
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }
  const b = (body ?? {}) as Record<string, unknown>
  const questionId = typeof b.question_id === 'string' ? b.question_id.trim() : ''
  const text = typeof b.body === 'string' ? b.body.trim() : ''
  if (!questionId) return NextResponse.json({ ok: false, message: 'Which thread?' }, { status: 400 })
  if (text.length < 2) return NextResponse.json({ ok: false, message: 'Type your message first.' }, { status: 400 })

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  let bamId: string | null = null
  if (devBypass) {
    bamId = (await devBypassBam(db))?.id ?? null
  } else {
    const { data } = await db.from('bams').select('id').eq('auth_user_id', userId).limit(1)
    bamId = ((data ?? [])[0] as { id: string } | undefined)?.id ?? null
  }
  if (!bamId) return NextResponse.json({ ok: false, message: 'We could not find your record.' }, { status: 404 })

  // The thread must be THEIRS. Checked against the session's bam_id, not against anything in the
  // request, or a question_id in a payload becomes a way to post into someone else's thread.
  const { data: own, error: ownErr } = await db
    .from('portal_questions').select('id').eq('id', questionId).eq('bam_id', bamId).limit(1)
  if (ownErr) {
    console.error('[portal/questions POST] ownership check failed:', ownErr.message)
    return NextResponse.json({ ok: false, message: 'Please try again.' }, { status: 503 })
  }
  if (((own ?? []).length) === 0) {
    return NextResponse.json({ ok: false, message: 'That thread is not yours.' }, { status: 403 })
  }

  const { data: made, error: insErr } = await db
    .from('portal_question_messages')
    .insert({ question_id: questionId, author: 'bam', body: text })
    .select('id, author, body, created_at')
  if (insErr) {
    console.error('[portal/questions POST] insert failed:', insErr.message)
    return NextResponse.json({ ok: false, message: 'That did not send. Please try again.' }, { status: 500 })
  }

  // A new message from the student means the thread is waiting again. Clearing answered_at also puts
  // it back in the admin Open tab and back in the sidebar count, which is the point: otherwise a
  // follow-up lands in a thread nobody is looking at any more.
  const { error: reopenErr } = await db
    .from('portal_questions')
    .update({ answered_at: null, answered_by: null })
    .eq('id', questionId)
  if (reopenErr) {
    // The message IS saved, so this is not data loss; it means the thread still reads as answered.
    console.error('[portal/questions POST] could not reopen the thread:', reopenErr.message)
  }

  return NextResponse.json({
    ok: true,
    message: (made ?? [])[0] ?? null,
    reopened: !reopenErr
  })
}
