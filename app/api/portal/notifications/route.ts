/**
 * GET  /api/portal/notifications              — this student's notifications and unread count
 * POST /api/portal/notifications  { action: 'mark_read' | 'mark_all_read', ids? }
 *
 * The student half of the bell. Mirrors /api/admin/notifications, with one difference that is
 * the whole reason the table is separate: every statement here is scoped to the caller's own
 * bam_id, resolved from their SESSION. No id from the request body is ever used to decide
 * whose rows are touched, because a row id in a payload is how one student marks another
 * student's notifications read.
 *
 * Service role, like every other portal route, so the query is not at the mercy of a policy
 * regression. RLS on bam_notifications (0028) is the second line, not the only one.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { getSessionUser, isDevBypass } from '../../../../lib/admin-auth'
import { devBypassBam } from '../../../../lib/dev-bam'

/** Enough to fill the panel several times over; it is a status board, not an archive. */
const LIMIT = 50

type Db = ReturnType<typeof serviceClient>

/**
 * Who is asking, as a bams.id, or a response explaining why not.
 *
 * An admin with no roster row is `null` rather than an error: they are allowed to look at the
 * portal, they simply have no notifications of their own.
 */
async function callerBamId(
  db: Db
): Promise<{ ok: true; bamId: string | null } | { ok: false; res: NextResponse }> {
  if (isDevBypass()) {
    const row = await devBypassBam(db)
    return { ok: true, bamId: row?.id ?? null }
  }

  const session = await getSessionUser()
  if (!session.ok) {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, message: session.message }, { status: session.status })
    }
  }

  const { data, error } = await db
    .from('bams')
    .select('id')
    .eq('auth_user_id', session.user.id)
    .limit(1)

  if (error) {
    console.error('[portal/notifications] bam lookup failed:', error.message)
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, message: 'We could not load your notifications just now.' },
        { status: 503 }
      )
    }
  }
  return { ok: true, bamId: ((data ?? [])[0] as { id: string } | undefined)?.id ?? null }
}

export async function GET() {
  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const who = await callerBamId(db)
  if (!who.ok) return who.res
  if (!who.bamId) return NextResponse.json({ ok: true, data: [], unreadCount: 0, applicable: false })

  const { data, error } = await db
    .from('bam_notifications')
    .select('id, type, title, body, link, period, read, created_at')
    .eq('bam_id', who.bamId)
    .order('created_at', { ascending: false })
    .limit(LIMIT)

  if (error) {
    console.error('[portal/notifications GET] read failed:', error.message)
    return NextResponse.json(
      { ok: false, message: 'We could not load your notifications just now.' },
      { status: 503 }
    )
  }

  const rows = (data ?? []) as Array<{ read: boolean }>
  return NextResponse.json({
    ok: true,
    data: rows,
    // Counted from the same rows the panel is about to render, so the badge and the list can
    // never disagree. A separate head-count query can, and a badge that says 3 over an empty
    // panel is the kind of thing nobody reports and everybody stops trusting.
    unreadCount: rows.filter(r => !r.read).length,
    applicable: true
  })
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }
  const { action, ids } = (body ?? {}) as { action?: unknown; ids?: unknown }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const who = await callerBamId(db)
  if (!who.ok) return who.res
  if (!who.bamId) {
    return NextResponse.json({ ok: false, message: 'You have no notifications.' }, { status: 404 })
  }

  if (action === 'mark_read') {
    const idList = Array.isArray(ids)
      ? ids.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : []
    if (idList.length === 0) {
      return NextResponse.json({ ok: false, message: 'ids required' }, { status: 400 })
    }
    // .in(id) AND .eq(bam_id). The id filter alone would let a guessed uuid from another
    // student's list be marked read from here.
    const { data, error } = await db
      .from('bam_notifications')
      .update({ read: true })
      .in('id', idList)
      .eq('bam_id', who.bamId)
      .select('id')
    if (error) {
      console.error('[portal/notifications mark_read] failed:', error.message)
      return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, updated: data?.length ?? 0 })
  }

  if (action === 'mark_all_read') {
    const { data, error } = await db
      .from('bam_notifications')
      .update({ read: true })
      .eq('bam_id', who.bamId)
      .eq('read', false)
      .select('id')
    if (error) {
      console.error('[portal/notifications mark_all_read] failed:', error.message)
      return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, updated: data?.length ?? 0 })
  }

  return NextResponse.json({ ok: false, message: 'invalid action' }, { status: 400 })
}
