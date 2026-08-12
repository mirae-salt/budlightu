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
  parseQuestionNotify,
  validateQuestionNotify,
  modeFor,
  hasOwnSetting,
  withModeFor
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
    // Report a value AND that it could not be read, so the page does not show a confident
    // setting it never loaded.
    return NextResponse.json({
      ok: true,
      setting: { mode: 'each' },
      isOwn: false,
      degraded: true,
      message: error.message
    })
  }

  const row = (data ?? [])[0] as { value_json?: unknown } | undefined
  const settings = parseQuestionNotify(row?.value_json)

  // THIS ADMIN's mode, not a shared one. The page used to show and write a single global
  // value, so one admin changing it silently changed everyone's.
  return NextResponse.json({
    ok: true,
    setting: { mode: modeFor(settings, auth.email) },
    isOwn: hasOwnSetting(settings, auth.email),
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

  // Read first, then apply this admin's choice on top. Writing the whole object without
  // reading it would wipe the other admins' entries, which is the bug this replaced in a
  // different form.
  const { data: current, error: readErr } = await db
    .from('policy').select('value_json').eq('key', QUESTION_NOTIFY_KEY).limit(1)
  if (readErr) {
    console.error('[question-notify PUT] read-before-write failed:', readErr.message)
    return NextResponse.json(
      { ok: false, message: `Could not read the current settings, so nothing was changed: ${readErr.message}` },
      { status: 500 }
    )
  }
  const existing = parseQuestionNotify(((current ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)
  const next = withModeFor(existing, auth.email, parsed.mode)

  const { data: saved, error } = await db
    .from('policy')
    .upsert(
      {
        key: QUESTION_NOTIFY_KEY,
        value_json: next,
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
  const storedMine = modeFor(stored, auth.email)
  if (storedMine !== parsed.mode) {
    console.error(
      `[question-notify PUT] read-back mismatch for ${auth.email}: wanted ${parsed.mode}, stored ${storedMine}`
    )
    return NextResponse.json(
      { ok: false, message: 'The setting did not save. Reload the page to see what is actually stored.' },
      { status: 500 }
    )
  }
  // Nobody else's entry may have moved. Checked rather than assumed, because this is the
  // exact failure being fixed.
  for (const [email, mode] of Object.entries(existing.byEmail)) {
    if (email === (auth.email ?? '').trim().toLowerCase()) continue
    if (stored.byEmail[email] !== mode) {
      console.error(`[question-notify PUT] would have changed ${email} from ${mode} to ${stored.byEmail[email]}`)
      return NextResponse.json(
        { ok: false, message: 'That change would have altered another admin setting, so it was rejected. Tell Mirae.' },
        { status: 500 }
      )
    }
  }

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'policy',
    entity_id: null,
    action: 'question_notify_changed',
    after_json: { key: QUESTION_NOTIFY_KEY, admin: auth.email, mode: storedMine }
  })
  if (auditErr) {
    console.error('[question-notify PUT] audit_log insert failed:', auditErr.message)
    return NextResponse.json({
      ok: true,
      setting: { mode: storedMine },
      warning: 'The setting was saved, but the audit log entry could not be written.'
    })
  }

  return NextResponse.json({ ok: true, setting: { mode: storedMine } })
}
