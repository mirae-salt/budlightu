/**
 * GET /api/verify-account/tail
 * Returns the last 4 digits of the logged-in BAM's account number.
 * The full account is decrypted server-side; only the tail crosses the wire.
 *
 * P0-A (step 5): this route used to read `bam_id` from `user_metadata`, which the
 * user's own session can write with the anon key:
 *
 *     await supabase.auth.updateUser({ data: { bam_id: '<someone else>' } })
 *
 * That let any signed-in user read another BAM's account tail. The BAM is now
 * resolved from the database via `bams.auth_user_id = auth.uid()`, which no
 * client can influence. See `requireBam()` in lib/admin-auth.ts.
 */
import { NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireBam, denied } from '../../../../lib/admin-auth'

export async function GET() {
  const auth = await requireBam()
  if (!auth.ok) return denied(auth)

  let admin
  try {
    admin = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('decrypt_bam_banking', { p_bam_id: auth.bamId }).single()
  if (error || !data) {
    console.error('[verify-account/tail] decrypt failed for bam', auth.bamId, error?.message)
    return NextResponse.json(
      { ok: false, message: 'Could not read your banking details. Contact your program manager.' },
      { status: 500 }
    )
  }

  const acct = (data as { account_no?: string | null }).account_no ?? ''
  if (acct.length < 4) {
    return NextResponse.json(
      { ok: false, message: 'No banking details are on file yet.' },
      { status: 404 }
    )
  }

  return NextResponse.json({ ok: true, tail: acct.slice(-4) })
}
