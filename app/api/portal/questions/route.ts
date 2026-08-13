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

  const { data, error } = await db
    .from('portal_questions')
    .select('id, question, answer, answered_at, submitted_at')
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

  return NextResponse.json({ ok: true, questions: data ?? [] })
}
