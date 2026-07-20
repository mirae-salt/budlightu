/**
 * POST /api/verify-account/confirm
 * Stamps bams.email_verified_at = now() for the logged-in BAM.
 * Unlocks sendBamCopy (P0-4).
 */
import { NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function POST() {
  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: user } = await supa.auth.getUser()
  if (!user.user) return NextResponse.json({ ok: false }, { status: 401 })

  const bamId = (user.user.user_metadata as { bam_id?: string }).bam_id
  if (!bamId) return NextResponse.json({ ok: false }, { status: 403 })

  const admin = serviceClient()
  const { error } = await admin.from('bams')
    .update({ email_verified_at: new Date().toISOString() })
    .eq('id', bamId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  await admin.from('audit_log').insert({
    actor_id: user.user.id, actor_role: 'bam', entity: 'bams',
    entity_id: bamId, action: 'email_verified'
  })

  return NextResponse.json({ ok: true })
}
