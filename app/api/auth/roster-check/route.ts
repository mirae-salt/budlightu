/**
 * POST /api/auth/roster-check  { email }
 * Verifies the email exists in the bams roster. If an auth user doesn't
 * exist yet, creates one (admin API) so signInWithOtp can send a magic link.
 * This is the access gate: only rostered BAMs can receive sign-in emails.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'

export async function POST(req: NextRequest) {
  const { email } = await req.json()
  if (!email) return NextResponse.json({ ok: false, message: 'email required' }, { status: 400 })

  const normEmail = email.trim().toLowerCase()
  const db = serviceClient()

  const { data: bam, error: bamErr } = await db
    .from('bams')
    .select('id, auth_user_id, status')
    .eq('email', normEmail)
    .single()

  if (bamErr || !bam) {
    return NextResponse.json(
      { ok: false, message: 'This email is not in our program roster. Contact your program manager if you think this is a mistake.' },
      { status: 404 }
    )
  }

  if (bam.status === 'inactive') {
    return NextResponse.json(
      { ok: false, message: 'Your account has been deactivated. Contact your program manager.' },
      { status: 403 }
    )
  }

  // Create or find auth user if this BAM doesn't have one yet (first-time flow)
  if (!bam.auth_user_id) {
    let authUserId: string | null = null

    const { data: authUser, error: authErr } = await db.auth.admin.createUser({
      email: normEmail,
      email_confirm: true,
      user_metadata: { role: 'bam', bam_id: bam.id }
    })

    if (authUser?.user) {
      authUserId = authUser.user.id
    } else if (authErr?.message?.toLowerCase().includes('already') || authErr?.status === 422) {
      // Auth user already exists (prior attempt or token-based onboarding) — find and link
      const { data: { users } } = await db.auth.admin.listUsers({ perPage: 500 })
      const existing = users?.find((u: { email?: string }) => u.email?.toLowerCase() === normEmail)
      if (existing) {
        authUserId = existing.id
        await db.auth.admin.updateUserById(existing.id, {
          user_metadata: { role: 'bam', bam_id: bam.id }
        })
      }
    }

    if (!authUserId) {
      console.error('roster-check auth setup failed:', authErr?.message)
      return NextResponse.json(
        { ok: false, message: 'Failed to set up your account. Please try again or contact your program manager.' },
        { status: 500 }
      )
    }

    await db.from('bams').update({ auth_user_id: authUserId }).eq('id', bam.id)
  }

  return NextResponse.json({ ok: true })
}
