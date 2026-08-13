/**
 * PUT /api/admin/questions  { id, answer?, answered }
 *
 * Marks a support question answered, and optionally emails the reply to the BAM.
 *
 * WHY BOTH, RATHER THAN ONE OR THE OTHER
 * --------------------------------------
 * The student has no inbox in the portal. If a reply is going to reach them at all it reaches
 * them by email, so "reply in the portal" and "reply by email" are not two options; the portal
 * is where you write it and the email is how it arrives.
 *
 * What IS a choice is whether we send it. Robin can hit Reply in Outlook, which is faster when
 * the answer is one line, and then the only thing missing here is the record. So `answer` is
 * optional: text means compose and send, no text means "I already handled this, mark it done".
 * Requiring the text would mean she pastes a copy of every reply, which is how a feature stops
 * being used and the list goes back to being unreliable.
 *
 * A send that fails does NOT mark it answered. The opposite would hide a question the BAM is
 * still waiting on.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import { sendEmail } from '../../../../lib/send-email'
import { appBaseUrl } from '../../../../lib/app-url'
import { notifyBam } from '../../../../lib/notify-bam'

function escapeHtml(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }

  const b = (body ?? {}) as Record<string, unknown>
  const id = typeof b.id === 'string' ? b.id.trim() : ''
  if (!id) return NextResponse.json({ ok: false, message: 'Which question?' }, { status: 400 })

  const answered = b.answered !== false
  const answerText = typeof b.answer === 'string' ? b.answer.trim() : ''

  // Reopening: clears the stamp so it shows up as waiting again. Kept because the alternative
  // when Robin marks the wrong card is that a real question is silently closed forever.
  if (!answered) {
    return reopen(id, auth)
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  // Read the question and the BAM first: an email cannot be sent without knowing who asked,
  // and marking answered is not worth doing if the row does not exist.
  const { data: rows, error: readErr } = await db
    .from('portal_questions')
    // Messages come along so the email can quote what they ACTUALLY last said. Quoting the original
    // question in reply to a third follow-up reads as not having read it.
    .select('id, bam_id, question, answered_at, bams(first_name, last_name, email), portal_question_messages(author, body, created_at)')
    .eq('id', id)
    .limit(1)
  if (readErr) {
    console.error('[admin/questions PUT] read failed:', readErr.message)
    return NextResponse.json(
      { ok: false, message: `Nothing was changed: ${readErr.message}` },
      { status: 500 }
    )
  }
  const row = (rows ?? [])[0] as {
    id: string
    /** Null on a question submitted before the dev bypass resolved a BAM (see lib/dev-bam.ts). */
    bam_id: string | null
    question: string
    answered_at: string | null
    portal_question_messages?: Array<{ author: string; body: string; created_at: string }>
    bams?: { first_name: string | null; last_name: string | null; email: string | null }
      | Array<{ first_name: string | null; last_name: string | null; email: string | null }>
      | null
  } | undefined
  if (!row) {
    return NextResponse.json({ ok: false, message: 'That question no longer exists.' }, { status: 404 })
  }

  // The student's most recent message, falling back to the original question for a thread that
  // predates migration 0027 or whose messages could not be read.
  const msgs = (row as { portal_question_messages?: Array<{ author: string; body: string; created_at: string }> })
    .portal_question_messages ?? []
  const lastFromBam = [...msgs]
    .filter(m => m.author === 'bam')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1)
  const quoted = lastFromBam?.body ?? row.question

  const bam = Array.isArray(row.bams) ? row.bams[0] : row.bams
  const bamEmail = (bam?.email ?? '').trim()
  const bamName = bam?.first_name ?? 'there'

  // Sending comes BEFORE the stamp. If the email fails, the question stays open, because a
  // closed question the BAM never heard back about is the one outcome worth avoiding.
  let emailed = false
  if (answerText) {
    if (!bamEmail) {
      return NextResponse.json(
        {
          ok: false,
          message: 'This question has no BAM email attached, so a reply cannot be sent. You can still mark it answered without text.'
        },
        { status: 400 }
      )
    }

    const base = appBaseUrl()
    // Checks `sent`, not just rejection: sendEmail resolves with { sent: false } on a provider
    // failure. Marking a question answered when the reply never left is the one outcome this route
    // is written to avoid, and it was doing exactly that. Audited 2026-08-13.
    const err = await sendEmail({
      to: bamEmail,
      replyTo: auth.email ?? undefined,
      /*
       * Says what happened, and which one.
       *
       * Was 'Re: your Bud Light U question'. "Re:" makes it look like a thread the student started in
       * their own inbox, and it does not say the thing worth knowing: that an answer arrived. A
       * student with three open threads also could not tell which one it was about.
       *
       * The snippet is their own words, trimmed to fit a subject line and stripped of newlines so a
       * multi-line question does not break the header.
       */
      subject: (() => {
        const snippet = quoted.replace(/\s+/g, ' ').trim()
        const short = snippet.length > 42 ? `${snippet.slice(0, 42).trimEnd()}...` : snippet
        return short
          ? `Answered: ${short}`
          : 'Your Bud Light U question has been answered'
      })(),
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
          <p style="font-size: 15px; color: #1a1a2e; margin: 0 0 16px;">Hi ${escapeHtml(bamName)},</p>
          <div style="font-size: 14px; color: #374151; line-height: 1.7; white-space: pre-wrap; margin: 0 0 20px;">${escapeHtml(answerText)}</div>
          <div style="border-left: 3px solid #e5e7eb; padding: 4px 0 4px 14px; margin: 0 0 20px;">
            <p style="font-size: 12px; color: #9ca3af; margin: 0 0 6px;">You wrote:</p>
            <div style="font-size: 13px; color: #6b7280; white-space: pre-wrap; line-height: 1.6;">${escapeHtml(quoted)}</div>
          </div>
          <!--
            A BUTTON, not a link inside a sentence. Mirae: 바로가기로 해야지. A student who has more
            to say should not have to find the way back inside a paragraph.

            Worded "Ask a follow-up" rather than "View the thread" on purpose: /portal/support is
            currently a submit form, so a thread link would be a promise the page cannot keep until
            handoff item 1.3 ships. The href does not change when it does.
          -->
          <p style="margin: 0 0 18px;">
            <a href="${escapeHtml(base)}/portal/support"
               style="background: #0073cf; color: #ffffff; padding: 11px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block;">
              Ask a follow-up
            </a>
          </p>
          <p style="font-size: 13px; color: #6b7280; line-height: 1.6; margin: 0;">
            Replying straight to this email reaches us too.
          </p>
          <p style="font-size: 12px; color: #9ca3af; margin-top: 20px;">Bud Light U</p>
        </div>
      `,
      text: [
        `Hi ${bamName},`,
        '',
        answerText,
        '',
        'You wrote:',
        quoted,
        '',
        `Ask a follow-up: ${base}/portal/support`,
        'Replying straight to this email reaches us too.',
        '',
        '- Bud Light U'
      ].join('\n')
    })
      .then(r => (r.sent ? null : (r.error ?? `send failed via ${r.provider}`)))
      .catch((e: unknown) => (e instanceof Error ? e.message : 'send threw'))

    if (err) {
      console.error('[admin/questions PUT] reply email failed:', err)
      return NextResponse.json(
        {
          ok: false,
          message: `The reply did not send, so the question is still open: ${err}`
        },
        { status: 502 }
      )
    }
    emailed = true
  }

  // APPEND the reply as a message, then stamp the thread.
  //
  // `portal_questions.answer` is one column, so a second reply used to overwrite the first and the
  // conversation had no history. Migration 0027 added portal_question_messages; the column is still
  // written because other code and the reply email read it, but the messages are the record.
  if (answerText) {
    const { error: msgErr } = await db.from('portal_question_messages').insert({
      question_id: id,
      author: 'admin',
      author_user_id: auth.devBypass ? null : auth.userId,
      body: answerText
    })
    if (msgErr) {
      // The email already went out at this point, so say so rather than implying nothing happened.
      console.error('[admin/questions PUT] message insert failed:', msgErr.message)
      return NextResponse.json(
        {
          ok: false,
          message: `The reply was SENT but could not be added to the thread: ${msgErr.message}. Do not send it again.`
        },
        { status: 500 }
      )
    }
  }

  const { data: saved, error } = await db
    .from('portal_questions')
    .update({
      answered_at: new Date().toISOString(),
      answered_by: auth.devBypass ? null : auth.userId,
      // Only overwrite the stored answer when there is one. Marking an already-answered
      // question done again must not blank the reply that was sent.
      ...(answerText ? { answer: answerText } : {})
    })
    .eq('id', id)
    .select('id, answered_at, answer')

  if (error) {
    console.error('[admin/questions PUT] update failed:', error.message)
    return NextResponse.json(
      {
        ok: false,
        message: emailed
          ? `The reply was SENT but could not be recorded: ${error.message}. Do not send it again.`
          : `Nothing was changed: ${error.message}`
      },
      { status: 500 }
    )
  }

  // Read back: a question that still looks open after being answered gets answered twice.
  const stored = (saved ?? [])[0] as { answered_at: string | null } | undefined
  if (!stored?.answered_at) {
    console.error('[admin/questions PUT] read-back shows answered_at still null for', id)
    return NextResponse.json(
      {
        ok: false,
        message: emailed
          ? 'The reply was sent but the question did not get marked answered. Reload the page.'
          : 'That did not save. Reload the page.'
      },
      { status: 500 }
    )
  }

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'portal_questions',
    entity_id: id,
    action: 'question_answered',
    after_json: { emailed, hasText: Boolean(answerText) }
  })
  if (auditErr) console.error('[admin/questions PUT] audit_log insert failed:', auditErr.message)

  /*
   * The bell entry, ONLY when a reply was actually written and sent.
   *
   * The other branch of this route is "I already answered this in Outlook, mark it done", where
   * `answered_at` is a person's claim rather than a system fact (CLAUDE.md says so). A bell entry
   * saying "your question was answered" on that branch would point a student at a thread with
   * nothing new in it, which is the errand this whole design is written to avoid.
   *
   * Below the send: the send failing already returned 502 above, so reaching here means the
   * answer left. The bell is a record of something that happened, not an intention.
   */
  let inApp: { ok: boolean; error?: string } = { ok: false, error: 'no reply text' }
  const bamId = row.bam_id
  if (answerText && bamId) {
    inApp = await notifyBam({
      bam_id: bamId,
      type: 'question_answered',
      title: 'Your question was answered',
      // The answer itself, trimmed. The panel shows one line, and a student who can read the
      // gist there does not have to open anything at all.
      body: answerText.replace(/\s+/g, ' ').trim().slice(0, 140),
      link: '/portal/support'
    })
    if (!inApp.ok) console.error('[admin/questions PUT] bell notification failed:', inApp.error)
  }

  return NextResponse.json({
    ok: true,
    emailed,
    answeredAt: stored.answered_at,
    inApp: inApp.ok
  })
}

/** Puts a question back in the open list. No email either way. */
async function reopen(
  id: string,
  auth: Extract<Awaited<ReturnType<typeof requireAdmin>>, { ok: true }>
) {
  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data: saved, error } = await db
    .from('portal_questions')
    // The answer text is kept. It is a record of what was already said, and clearing it would
    // lose that just because someone reopened the thread.
    .update({ answered_at: null, answered_by: null })
    .eq('id', id)
    .select('id, answered_at')

  if (error) {
    console.error('[admin/questions reopen] failed:', error.message)
    return NextResponse.json({ ok: false, message: `Nothing was changed: ${error.message}` }, { status: 500 })
  }
  const stored = (saved ?? [])[0] as { answered_at: string | null } | undefined
  if (!stored) {
    return NextResponse.json({ ok: false, message: 'That question no longer exists.' }, { status: 404 })
  }
  if (stored.answered_at !== null) {
    return NextResponse.json(
      { ok: false, message: 'That did not save. Reload the page.' },
      { status: 500 }
    )
  }

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'portal_questions',
    entity_id: id,
    action: 'question_reopened'
  })
  if (auditErr) console.error('[admin/questions reopen] audit_log insert failed:', auditErr.message)

  return NextResponse.json({ ok: true, emailed: false, answeredAt: null })
}
