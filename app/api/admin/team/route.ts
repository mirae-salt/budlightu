/**
 * Admin team management API.
 * GET    — list all admin users
 * POST   — add an admin user (creates Supabase auth user + sets the role claim)
 * DELETE — revoke the admin role from a user
 *
 * Only super_admin can manage the team.
 *
 * P0-A: roles are read from and written to `app_metadata`, which only the
 * service role can write. `user_metadata` is writable by the user's own session
 * with the anon key, so a role stored there was self-assignable. Display fields
 * (first_name/last_name) stay in `user_metadata` because they are not
 * authorization data.
 *
 * P1-21: revocation used to build `{ ...meta, role: undefined }`. JSON.stringify
 * drops undefined keys, and GoTrue only deletes a key when it is explicitly
 * `null`, so the role could survive while this route returned ok:true and wrote
 * a remove_admin audit row. Revocation now writes an explicit null AND reads the
 * user back to confirm the role is gone before reporting success.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireSuperAdmin, requireAdmin, denied } from '../../../../lib/admin-auth'
import { getRole, isAdminRole, roleClaimPatch, type AdminRole } from '../../../../lib/auth-claims'
import { parseEmail, cleanText } from '../../../../lib/sanitize'

type MetaName = { first_name?: string; last_name?: string }

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let admin
  try {
    admin = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 })
  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  }

  const admins = (data?.users ?? [])
    .map(u => ({ u, role: getRole(u) }))
    .filter(({ role }) => isAdminRole(role))
    .map(({ u, role }) => {
      const meta = (u.user_metadata ?? {}) as MetaName
      return {
        id: u.id,
        email: u.email ?? '',
        first_name: meta.first_name ?? '',
        last_name: meta.last_name ?? '',
        role: role as AdminRole,
        created_at: u.created_at
      }
    })

  // Who is asking. The invoice page needs it so "Test send to me" mails the signed-in
  // admin rather than a hardcoded address.
  return NextResponse.json({
    ok: true,
    admins,
    me: { id: auth.devBypass ? null : auth.userId, email: auth.email ?? null, role: auth.role }
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }

  const { email, first_name, last_name, role } = (body ?? {}) as {
    email?: unknown; first_name?: unknown; last_name?: unknown; role?: unknown
  }

  const parsedEmail = parseEmail(email)
  if (!parsedEmail.ok) {
    return NextResponse.json({ ok: false, message: parsedEmail.reason }, { status: 400 })
  }
  const firstName = cleanText(typeof first_name === 'string' ? first_name : '')
  const lastName = cleanText(typeof last_name === 'string' ? last_name : '')
  if (!firstName) {
    return NextResponse.json({ ok: false, message: 'Email and first name required' }, { status: 400 })
  }
  if (typeof role !== 'string' || !isAdminRole(role)) {
    return NextResponse.json({ ok: false, message: 'Invalid role' }, { status: 400 })
  }

  let admin
  try {
    admin = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data: listed, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 })
  if (listErr) {
    return NextResponse.json({ ok: false, message: listErr.message }, { status: 500 })
  }

  const existingUser = (listed?.users ?? []).find(
    u => (u.email ?? '').trim().toLowerCase() === parsedEmail.email
  )

  let grantedUserId: string

  if (existingUser) {
    if (isAdminRole(getRole(existingUser))) {
      return NextResponse.json({ ok: false, message: 'This user is already an admin' }, { status: 409 })
    }
    const { error } = await admin.auth.admin.updateUserById(existingUser.id, {
      app_metadata: roleClaimPatch(existingUser.app_metadata, { role }),
      user_metadata: { ...(existingUser.user_metadata ?? {}), first_name: firstName, last_name: lastName }
    })
    if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
    grantedUserId = existingUser.id
  } else {
    const { data: created, error } = await admin.auth.admin.createUser({
      email: parsedEmail.email,
      email_confirm: true,
      app_metadata: { role },
      user_metadata: { first_name: firstName, last_name: lastName }
    })
    if (error || !created?.user) {
      return NextResponse.json({ ok: false, message: error?.message ?? 'Could not create the user' }, { status: 500 })
    }
    grantedUserId = created.user.id
  }

  // Read back: a grant is only real if the trusted claim actually carries it.
  const { data: verify, error: verifyErr } = await admin.auth.admin.getUserById(grantedUserId)
  if (verifyErr || !verify?.user || getRole(verify.user) !== role) {
    console.error(
      `[team POST] role grant not confirmed for ${parsedEmail.email}: ` +
      `wanted "${role}", read back "${getRole(verify?.user) ?? 'none'}" ${verifyErr?.message ?? ''}`
    )
    return NextResponse.json(
      { ok: false, message: 'The admin role was not confirmed on the account. Nothing was recorded. Please try again.' },
      { status: 500 }
    )
  }

  // audit_log columns are (actor_id, actor_role, entity, entity_id uuid, action,
  // before_json, after_json, ts). There is NO `meta` column: the previous code
  // passed one, so PostgREST rejected the insert and, because the error was
  // discarded, EVERY add_admin/remove_admin audit row silently failed to exist.
  // `entity_id` is uuid, so the email goes in after_json, not there.
  const { error: auditErr } = await admin.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: 'super_admin',
    entity: 'admin_team',
    entity_id: grantedUserId,
    action: 'add_admin',
    after_json: { email: parsedEmail.email, role, first_name: firstName, last_name: lastName, user_id: grantedUserId }
  })
  if (auditErr) {
    // The grant succeeded and is verified; refusing now would leave the grant in
    // place anyway. Report it so the missing audit row is not invisible.
    console.error('[team POST] audit_log insert failed:', auditErr.message)
    return NextResponse.json({
      ok: true,
      warning: 'Admin added, but the audit log entry could not be written. Tell Mirae.'
    })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }

  const { user_id } = (body ?? {}) as { user_id?: unknown }
  if (typeof user_id !== 'string' || !user_id) {
    return NextResponse.json({ ok: false, message: 'user_id required' }, { status: 400 })
  }
  if (user_id === auth.userId) {
    return NextResponse.json({ ok: false, message: 'Cannot remove yourself' }, { status: 400 })
  }

  let admin
  try {
    admin = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data: found, error: getErr } = await admin.auth.admin.getUserById(user_id)
  if (getErr || !found?.user) {
    return NextResponse.json({ ok: false, message: 'User not found' }, { status: 404 })
  }
  const user = found.user

  // Explicit null, not undefined. roleClaimPatch enforces this.
  const { error } = await admin.auth.admin.updateUserById(user_id, {
    app_metadata: roleClaimPatch(user.app_metadata, { role: null })
  })
  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })

  // Verify the revocation before claiming it happened, and before writing an
  // audit row that says access was removed.
  const { data: after, error: afterErr } = await admin.auth.admin.getUserById(user_id)
  if (afterErr || !after?.user) {
    return NextResponse.json(
      { ok: false, message: 'Could not confirm the change. Access may still be active. Please retry.' },
      { status: 500 }
    )
  }
  const remaining = getRole(after.user)
  if (isAdminRole(remaining)) {
    console.error(`[team DELETE] revocation did not take effect for ${user.email}: role is still "${remaining}"`)
    return NextResponse.json(
      { ok: false, message: 'Admin access is still active on that account. Nothing was recorded. Tell Mirae.' },
      { status: 500 }
    )
  }

  // Legacy cleanup: a stale user_metadata.role is not honoured anywhere any
  // more, but leaving it behind is confusing during the migration window.
  const legacyMeta = (user.user_metadata ?? {}) as Record<string, unknown>
  if (typeof legacyMeta.role === 'string') {
    const { error: legacyErr } = await admin.auth.admin.updateUserById(user_id, {
      user_metadata: { ...legacyMeta, role: null }
    })
    if (legacyErr) console.error('[team DELETE] could not clear legacy user_metadata.role:', legacyErr.message)
  }

  const { error: auditErr } = await admin.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: 'super_admin',
    entity: 'admin_team',
    entity_id: user_id,
    action: 'remove_admin',
    before_json: { role: getRole(user), email: user.email },
    after_json: { role: null, email: user.email, user_id }
  })
  if (auditErr) {
    console.error('[team DELETE] audit_log insert failed:', auditErr.message)
    return NextResponse.json({
      ok: true,
      warning: 'Access removed, but the audit log entry could not be written. Tell Mirae.'
    })
  }

  return NextResponse.json({ ok: true })
}
