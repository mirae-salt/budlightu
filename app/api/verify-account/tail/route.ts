/**
 * GET /api/verify-account/tail
 * Returns the last 4 digits of the logged-in BAM's account number.
 * Full account is decrypted server-side; only the tail crosses the wire.
 */
import { NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function GET() {
  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: {
      getAll:    () => cookieStore.getAll(),
      setAll:    () => {} // read-only for this endpoint
    }
  })
  const { data: user } = await supa.auth.getUser()
  if (!user.user) return NextResponse.json({ ok: false }, { status: 401 })

  const bamId = (user.user.user_metadata as { bam_id?: string }).bam_id
  if (!bamId) return NextResponse.json({ ok: false }, { status: 403 })

  const admin = serviceClient()
  const { data, error } = await admin.rpc('decrypt_bam_banking', { p_bam_id: bamId }).single()
  if (error || !data) return NextResponse.json({ ok: false, error: error?.message }, { status: 500 })

  const acct = (data as { account_no: string }).account_no ?? ''
  const tail = acct.slice(-4)
  return NextResponse.json({ ok: true, tail })
}
