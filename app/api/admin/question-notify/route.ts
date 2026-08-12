/**
 * GET  /api/admin/question-notify  — read how often support questions are emailed
 * PUT  /api/admin/question-notify  — set it
 *
 * Robin's setting, not ours. /api/portal/support emailed on every question, which is
 * right at three a month and wrong during onboarding week with 58 BAMs. The person
 * receiving the mail is the one who should be able to turn the volume down, without
 * asking anyone to change code.
 *
 * Stored in the existing `policy` table, like maintenance mode: no new table, no
 * redeploy, effective on the next question.
 *
 * requireAdmin rather than requireSuperAdmin: this changes who gets an email, not who
 * has access, and both admins answer these questions.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import {
  QUESTION_NOTIFY_KEY,
  QUESTION_NOTIFY_DEFAULT,
  parseQuestionNotify,
  validateQuestionNotify
} from '../../../../lib/question-notify'

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data, error } = await db
    .from('policy').select('value_json').eq('key', QUESTION_NOTIFY_KEY).limit(1)

  if (error) {
    console.error('[question-notify GET] read failed:', error.message)
    // Report the default AND that it could not be read, so the page does not show a
    // confident setting it never loaded.
    return NextResponse.json({
      ok: true,
      setting: QUESTION_NOTIFY_DEFAULT,
      degraded: true,
      message: error.message
    })
  }

  const row = (data ?? [])[0] as { value_json?: unknown } | undefined
  return NextResponse.json({
    ok: true,
    setting: parseQuestionNotify(row?.value_json),
    degraded: false
  })
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

  const parsed = validateQuestionNotify(body)
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, message: parsed.message }, { status: 400 })
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data: saved, error } = await db
    .from('policy')
    .upsert(
      {
        key: QUESTION_NOTIFY_KEY,
        value_json: parsed.value,
        updated_at: new Date().toISOString(),
        updated_by: auth.devBypass ? null : auth.userId
      },
      { onConflict: 'key' }
    )
    .select('value_json')

  if (error) {
    console.error('[question-notify PUT] write failed:', error.message)
    return NextResponse.json(
      { ok: false, message: `The setting was not changed: ${error.message}` },
      { status: 500 }
    )
  }

  // Read back. Telling Robin she turned emails off when she did not means she stops
  // watching her inbox for questions that are still only arriving there.
  const stored = parseQuestionNotify(((saved ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)
  if (stored.mode !== parsed.value.mode) {
    console.error(
      `[question-notify PUT] read-back mismatch: wanted ${parsed.value.mode}, stored ${stored.mode}`
    )
    return NextResponse.json(
      { ok: false, message: 'The setting did not save. Reload the page to see what is actually stored.' },
      { status: 500 }
    )
  }

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'policy',
    entity_id: null,
    action: 'question_notify_changed',
    after_json: { key: QUESTION_NOTIFY_KEY, mode: stored.mode }
  })
  if (auditErr) {
    console.error('[question-notify PUT] audit_log insert failed:', auditErr.message)
    return NextResponse.json({
      ok: true,
      setting: stored,
      warning: 'The setting was saved, but the audit log entry could not be written.'
    })
  }

  return NextResponse.json({ ok: true, setting: stored })
}
