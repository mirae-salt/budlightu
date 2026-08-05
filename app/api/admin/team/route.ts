/**
 * Admin team management API.
 * GET  — list all admin users
 * POST — add an admin user (creates Supabase auth user + sets role metadata)
 * DELETE — remove admin role from a user
 *
 * Only super_admin can manage the team.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'

async function getCallerRole(req: NextRequest) {
  const isDev = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
  if (isDev) return { role: 'super_admin', userId: 'dev' }

  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: { user } } = await supa.auth.getUser()
  if (!user) return null
  const role = (user.user_metadata as { role?: string }).role
  return { role, userId: user.id }
}

export async function GET(req: NextRequest) {
  const caller = await getCallerRole(req)
  if (!caller || !['super_admin', 'program_admin'].includes(caller.role ?? '')) {
    return NextResponse.json({ ok: false }, { status: 403 })
  }

  const admin = serviceClient()

  // List all auth users with admin roles
  const { data: { users }, error } = await admin.auth.admin.listUsers({ perPage: 200 })

  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  }

  const admins = (users ?? [])
    .filter(u => {
      const role = (u.user_metadata as { role?: string })?.role
      return role === 'super_admin' || role === 'program_admin'
    })
    .map(u => ({
      id: u.id,
      email: u.email ?? '',
      first_name: (u.user_metadata as { first_name?: string })?.first_name ?? '',
      last_name: (u.user_metadata as { last_name?: string })?.last_name ?? '',
      role: (u.user_metadata as { role?: string })?.role ?? 'program_admin',
      created_at: u.created_at
    }))

  return NextResponse.json({ ok: true, admins })
}

export async function POST(req: NextRequest) {
  const caller = await getCallerRole(req)
  if (!caller || caller.role !== 'super_admin') {
    return NextResponse.json({ ok: false, message: 'Super admin only' }, { status: 403 })
  }

  const body = await req.json()
  const { email, first_name, last_name, role } = body as {
    email: string; first_name: string; last_name: string; role: string
  }

  if (!email?.includes('@') || !first_name?.trim()) {
    return NextResponse.json({ ok: false, message: 'Email and first name required' }, { status: 400 })
  }
  if (!['super_admin', 'program_admin'].includes(role)) {
    return NextResponse.json({ ok: false, message: 'Invalid role' }, { status: 400 })
  }

  const admin = serviceClient()

  // Check if user already exists
  const { data: { users: existing } } = await admin.auth.admin.listUsers({ perPage: 200 })
  const existingUser = (existing ?? []).find(u => u.email?.toLowerCase() === email.toLowerCase())

  if (existingUser) {
    const currentRole = (existingUser.user_metadata as { role?: string })?.role
    if (currentRole === 'super_admin' || currentRole === 'program_admin') {
      return NextResponse.json({ ok: false, message: 'This user is already an admin' }, { status: 409 })
    }
    // Update existing user's metadata
    const { error } = await admin.auth.admin.updateUserById(existingUser.id, {
      user_metadata: { ...existingUser.user_metadata, role, first_name: first_name.trim(), last_name: (last_name ?? '').trim() }
    })
    if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  } else {
    // Create new auth user with admin role (they'll use OTP to sign in)
    const { error } = await admin.auth.admin.createUser({
      email: email.toLowerCase(),
      email_confirm: true,
      user_metadata: { role, first_name: first_name.trim(), last_name: (last_name ?? '').trim() }
    })
    if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  }

  // Audit log
  await admin.from('audit_log').insert({
    actor_id: caller.userId, actor_role: 'super_admin', entity: 'admin_team',
    entity_id: email, action: 'add_admin',
    meta: { email, role, first_name, last_name }
  })

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const caller = await getCallerRole(req)
  if (!caller || caller.role !== 'super_admin') {
    return NextResponse.json({ ok: false, message: 'Super admin only' }, { status: 403 })
  }

  const body = await req.json()
  const { user_id } = body as { user_id: string }
  if (!user_id) return NextResponse.json({ ok: false, message: 'user_id required' }, { status: 400 })

  if (user_id === caller.userId) {
    return NextResponse.json({ ok: false, message: 'Cannot remove yourself' }, { status: 400 })
  }

  const admin = serviceClient()

  const { data: { user }, error: getErr } = await admin.auth.admin.getUserById(user_id)
  if (getErr || !user) return NextResponse.json({ ok: false, message: 'User not found' }, { status: 404 })

  // Remove admin role from metadata
  const meta = { ...(user.user_metadata ?? {}), role: undefined }
  const { error } = await admin.auth.admin.updateUserById(user_id, { user_metadata: meta })
  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })

  await admin.from('audit_log').insert({
    actor_id: caller.userId, actor_role: 'super_admin', entity: 'admin_team',
    entity_id: user.email, action: 'remove_admin',
    meta: { email: user.email }
  })

  return NextResponse.json({ ok: true })
}
