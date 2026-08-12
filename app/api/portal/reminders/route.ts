/**
 * GET  /api/portal/reminders — does this BAM want deadline reminders
 * PUT  /api/portal/reminders  { wants: boolean }
 *
 * The student's own switch, and the ONLY thing on the account page they can actually change.
 * Everything else there files a request for a human to apply, because a portal that lets an
 * account holder rewrite their payout destination lets whoever steals the account do it too.
 * This is safe to let them set directly: the worst outcome of getting it wrong is one fewer
 * email, and it is reversible from the same screen.
 *
 * Two switches, two different questions, deliberately not merged:
 *   admin  (/admin/settings)  does the program send reminders at all
 *   student (here)            do I personally want to receive them
 * Either one being off means no email. An admin cannot switch a student's back on, and a
 * student cannot opt into a program that is not sending any.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { getSessionUser } from '../../../../lib/admin-auth'

export async function GET() {
  const session = await getSessionUser()
  if (!session.ok) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status })
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data, error } = await db
    .from('bams')
    .select('id, wants_reminders')
    .eq('auth_user_id', session.user.id)
    .limit(1)

  if (error) {
    console.error('[portal/reminders GET] read failed:', error.message)
    return NextResponse.json(
      { ok: false, message: 'We could not load your settings just now.' },
      { status: 503 }
    )
  }

  const row = (data ?? [])[0] as { id: string; wants_reminders: boolean | null } | undefined
  if (!row) {
    // An admin viewing the portal without a roster row. Nothing to set.
    return NextResponse.json({ ok: true, applicable: false, wants: true })
  }

  // A null means the column defaulted, which is opted IN. Only an explicit false is an opt-out,
  // so a student who has never touched this is not silently excluded.
  return NextResponse.json({ ok: true, applicable: true, wants: row.wants_reminders !== false })
}

export async function PUT(req: NextRequest) {
  const session = await getSessionUser()
  if (!session.ok) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }

  const wants = (body as { wants?: unknown } | null)?.wants
  if (typeof wants !== 'boolean') {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  // Scoped to THEIR auth_user_id, not to an id from the request body. A row id in a payload is
  // how one student ends up changing another student's settings.
  const { data: saved, error } = await db
    .from('bams')
    .update({ wants_reminders: wants })
    .eq('auth_user_id', session.user.id)
    .select('wants_reminders')

  if (error) {
    console.error('[portal/reminders PUT] write failed:', error.message)
    return NextResponse.json(
      { ok: false, message: 'That did not save. Please try again.' },
      { status: 500 }
    )
  }

  const rows = (saved ?? []) as Array<{ wants_reminders: boolean | null }>
  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, message: 'We could not find your record to update.' },
      { status: 404 }
    )
  }

  // Read back, because a toggle that shows "off" while the reminders keep arriving is the
  // version of this bug that makes someone stop trusting the whole portal.
  const stored = rows[0].wants_reminders !== false
  if (stored !== wants) {
    console.error(`[portal/reminders PUT] read-back mismatch: wanted ${wants}, stored ${stored}`)
    return NextResponse.json(
      { ok: false, message: 'That did not save. Reload to see your current setting.' },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true, wants: stored })
}
