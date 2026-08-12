/**
 * GET  /api/maintenance   — read the switch. PUBLIC.
 * PUT  /api/maintenance   — set the switch. super_admin only.
 *
 * The flag lives in the existing `policy` table (key/value_json), so no new table and
 * no RLS change. `policy` is admin-read / super_admin-write by RLS, which means a
 * student cannot read it directly -- hence this route reads it with the service client
 * and returns ONLY the three maintenance fields. Nothing else from that table leaves.
 *
 * GET is public on purpose: the notice has to be visible to someone who is not signed
 * in, and the response contains only a boolean, a message written for students, and a
 * timestamp. It discloses nothing.
 *
 * GET FAILS OPEN. A read error returns `on: false`, not a 500. If this endpoint could
 * take the portal down by being unavailable, a transient hiccup becomes an outage, and
 * the worst case of failing open is that a student sees a working app during
 * maintenance. Every auth gate in this codebase fails closed; this one is the
 * deliberate exception and the reason is written here so nobody "fixes" it.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../supabase/functions/_shared/supabase-admin'
import { requireSuperAdmin, denied } from '../../../lib/admin-auth'
import {
  MAINTENANCE_KEY,
  MAINTENANCE_OFF,
  parseMaintenance,
  validateMaintenanceInput
} from '../../../lib/maintenance'

export async function GET() {
  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: true, maintenance: MAINTENANCE_OFF, degraded: true })
  }

  const { data, error } = await db
    .from('policy')
    .select('value_json')
    .eq('key', MAINTENANCE_KEY)
    .limit(1)

  if (error) {
    console.error('[maintenance GET] read failed:', error.message)
    // Fail open. `degraded` is here so the admin page can say "we could not read the
    // switch" rather than showing a confident "Off".
    return NextResponse.json({ ok: true, maintenance: MAINTENANCE_OFF, degraded: true })
  }

  const row = (data ?? [])[0] as { value_json?: unknown } | undefined
  return NextResponse.json({
    ok: true,
    maintenance: parseMaintenance(row?.value_json),
    degraded: false
  })
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }

  const parsed = validateMaintenanceInput(body)
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
        key: MAINTENANCE_KEY,
        value_json: parsed.value,
        updated_at: new Date().toISOString(),
        updated_by: auth.devBypass ? null : auth.userId
      },
      { onConflict: 'key' }
    )
    .select('value_json')

  if (error) {
    console.error('[maintenance PUT] write failed:', error.message)
    return NextResponse.json(
      { ok: false, message: `The switch was not changed: ${error.message}` },
      { status: 500 }
    )
  }

  // Read-back. An upsert that reports success while matching nothing would leave the
  // admin believing the portal is in maintenance when students can still use it, or
  // worse, believing they turned it off when they had not.
  const stored = parseMaintenance(((saved ?? [])[0] as { value_json?: unknown } | undefined)?.value_json)
  if (stored.on !== parsed.value.on) {
    console.error(
      `[maintenance PUT] read-back mismatch: wanted on=${parsed.value.on}, stored on=${stored.on}`
    )
    return NextResponse.json(
      {
        ok: false,
        message: 'The switch did not save. Check the portal in another browser before relying on it.'
      },
      { status: 500 }
    )
  }

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'policy',
    entity_id: null,
    action: stored.on ? 'maintenance_on' : 'maintenance_off',
    after_json: { key: MAINTENANCE_KEY, ...stored }
  })
  if (auditErr) {
    console.error('[maintenance PUT] audit_log insert failed:', auditErr.message)
    return NextResponse.json({
      ok: true,
      maintenance: stored,
      warning: 'The switch was changed, but the audit log entry could not be written. Tell Mirae.'
    })
  }

  return NextResponse.json({ ok: true, maintenance: stored })
}
