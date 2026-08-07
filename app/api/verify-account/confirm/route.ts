/**
 * POST /api/verify-account/confirm
 * Stamps bams.email_verified_at = now() for the logged-in BAM.
 * Unlocks sendBamCopy (P0-4).
 *
 * P0-A: the BAM used to be identified by `user_metadata.bam_id`, which the
 * student's own session can rewrite with the anon key:
 *   await supabase.auth.updateUser({ data: { bam_id: '<someone else>' } })
 * That let anyone verify another BAM's address and unlock invoice copies to it.
 * `requireBam()` resolves the BAM from `bams.auth_user_id` instead, which only
 * the service role writes.
 */
import { NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireBam, denied } from '../../../../lib/admin-auth'

export async function POST() {
  const auth = await requireBam()
  if (!auth.ok) return denied(auth)

  const admin = serviceClient()
  const { data: updated, error } = await admin.from('bams')
    .update({ email_verified_at: new Date().toISOString() })
    .eq('id', auth.bamId)
    .select('id, email_verified_at')
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  // "0 rows affected" is a finding, not a success (ENGINEERING-RULES §3): this
  // stamp is the hard block that gates emailing invoices to a student.
  if (!updated || updated.length !== 1 || !updated[0].email_verified_at) {
    return NextResponse.json(
      { ok: false, message: 'Could not confirm your account. Please try again or contact your program manager.' },
      { status: 500 }
    )
  }

  const { error: auditErr } = await admin.from('audit_log').insert({
    actor_id: auth.userId, actor_role: 'bam', entity: 'bams',
    entity_id: auth.bamId, action: 'email_verified'
  })
  if (auditErr) console.error('[verify-account/confirm] audit_log insert failed:', auditErr.message)

  return NextResponse.json({ ok: true })
}
