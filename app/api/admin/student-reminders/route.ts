/**
 * GET  /api/admin/student-reminders — the switch, plus the exact email a student would get
 * PUT  /api/admin/student-reminders — change the switch
 *
 * The preview is the point of the GET. Robin is being asked to approve wording that goes to
 * 58 students, and "a reminder email on the 10th and 14th" is not something anyone can approve
 * without reading it. It is rendered by the same pure function the cron uses, so what she
 * reads is what sends.
 *
 * requireSuperAdmin, not requireAdmin: turning this to 'live' starts sending mail to students.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, requireSuperAdmin, denied } from '../../../../lib/admin-auth'
import { appBaseUrl } from '../../../../lib/app-url'
import {
  REMINDER_MODE_KEY,
  parseReminderSettings,
  validateReminderSettings,
  reminderEmail,
  REMINDER_DEFAULT
} from '../../../../lib/student-reminders'

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
    .from('policy').select('value_json').eq('key', REMINDER_MODE_KEY).limit(1)

  // A failed read reports the OFF default and says it could not be read. It must never render
  // as "live" on a page whose job is to tell you whether students are being emailed.
  const settings = error
    ? REMINDER_DEFAULT
    : parseReminderSettings(((data ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)
  if (error) console.error('[student-reminders GET] read failed:', error.message)

  // Five days out, which is the 10th. Everyone who gets this has submitted nothing, so there
  // are no spend figures to make realistic.
  const preview = reminderEmail({
    firstName: 'Alex',
    cap: 150,
    daysLeft: 5,
    monthLabel: 'September 2026',
    portalUrl: appBaseUrl()
  })

  return NextResponse.json({
    ok: true,
    settings,
    degraded: Boolean(error),
    preview
  })
}

export async function PUT(req: NextRequest) {
  // Super admin: this switch decides whether 58 students get mail.
  const auth = await requireSuperAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }

  const parsed = validateReminderSettings(body)
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, message: parsed.message }, { status: 400 })
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data: before } = await db
    .from('policy').select('value_json').eq('key', REMINDER_MODE_KEY).limit(1)
  const previous = parseReminderSettings(((before ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)

  const { data: saved, error } = await db
    .from('policy')
    .upsert(
      {
        key: REMINDER_MODE_KEY,
        value_json: parsed.settings,
        updated_at: new Date().toISOString(),
        updated_by: auth.devBypass ? null : auth.userId
      },
      { onConflict: 'key' }
    )
    .select('value_json')

  if (error) {
    console.error('[student-reminders PUT] write failed:', error.message)
    return NextResponse.json(
      { ok: false, message: `Nothing was changed: ${error.message}` },
      { status: 500 }
    )
  }

  // Read back. Telling someone reminders are off when they are live is the one direction of
  // this mistake that sends mail nobody expected.
  const stored = parseReminderSettings(((saved ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)
  if (stored.mode !== parsed.settings.mode) {
    console.error(
      `[student-reminders PUT] read-back mismatch: wanted ${parsed.settings.mode}, stored ${stored.mode}`
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
    action: 'student_reminders_changed',
    before_json: { mode: previous.mode, days: previous.days },
    after_json: { mode: stored.mode, days: stored.days }
  })
  if (auditErr) {
    console.error('[student-reminders PUT] audit_log insert failed:', auditErr.message)
    return NextResponse.json({
      ok: true,
      settings: stored,
      warning: 'Saved, but the audit log entry could not be written.'
    })
  }

  return NextResponse.json({ ok: true, settings: stored })
}
