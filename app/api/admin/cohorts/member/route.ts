/**
 * POST/DELETE /api/admin/cohorts/member — move a BAM into / out of a cohort.
 *
 * P0-A: the local `requireAdmin()` here read `user_metadata.role`, which the
 * user's own session can write, and returned a caller id for ANY request while
 * NODE_ENV was development (no ALLOW_DEV_AUTH_BYPASS gate). Replaced with the
 * shared helper, which reads app_metadata only and fails closed.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const { bam_id, cohort_id } = await req.json()
  if (!bam_id || !cohort_id) return NextResponse.json({ ok: false, message: 'bam_id and cohort_id required' }, { status: 400 })

  const admin = serviceClient()
  const { error } = await admin.from('bams').update({ cohort_id }).eq('id', bam_id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const { bam_id } = await req.json()
  if (!bam_id) return NextResponse.json({ ok: false, message: 'bam_id required' }, { status: 400 })

  const admin = serviceClient()
  const { error } = await admin.from('bams').update({ cohort_id: null }).eq('id', bam_id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
