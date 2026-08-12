/**
 * POST /api/admin/invite  { bam_id }
 * Generates a one-time invite token for a pending BAM, stores the SHA-256
 * hash in `bams.invite_token_hash`, sends the onboarding link via email
 * (Resend free tier), and returns the URL.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { sendBamInvite } from '../../../../lib/send-invite'
import { requireAdmin, denied } from '../../../../lib/admin-auth'

export async function POST(req: NextRequest) {
  const { bam_id } = await req.json()
  if (!bam_id) {
    return NextResponse.json({ ok: false, message: 'bam_id required' }, { status: 400 })
  }

  // --- auth: admin only (P0-A: role from app_metadata only) ---
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  // --- look up the BAM ---
  const admin = serviceClient()
  const { data: bam, error: fetchErr } = await admin
    .from('bams')
    .select('id, email, first_name, last_name, status, invite_token_hash')
    .eq('id', bam_id)
    .single()

  if (fetchErr || !bam) {
    return NextResponse.json({ ok: false, message: 'BAM not found' }, { status: 404 })
  }
  // The token-and-email work lives in lib/send-invite.ts so that Add BAM can do the
  // same thing without a second copy of it. This route stays the "re-invite an
  // existing pending BAM" entry point.
  const invite = await sendBamInvite(admin, {
    id: bam.id,
    email: bam.email,
    first_name: bam.first_name,
    status: bam.status
  })

  if (!invite.ok) {
    return NextResponse.json(
      { ok: false, message: invite.message },
      { status: invite.reason === 'not_invitable' ? 409 : 500 }
    )
  }

  // audit_log has no `meta` column and actor_id is a uuid, so the old insert
  // (`meta: {...}`, `actor_id: 'dev'`) was rejected by PostgREST every time and
  // the discarded error hid it: no invite has ever been audited.
  const { error: auditErr } = await admin.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'bams',
    entity_id: bam_id,
    action: 'invite_sent',
    after_json: { email: bam.email, provider: invite.emailProvider, sent: invite.emailSent }
  })
  if (auditErr) {
    console.error('[invite] audit_log insert failed:', auditErr.message)
  }

  return NextResponse.json({
    ok: true,
    invite_url: invite.inviteUrl,
    bam_email: bam.email,
    bam_name: `${bam.first_name} ${bam.last_name}`,
    email_sent: invite.emailSent,
    email_provider: invite.emailProvider,
    email_error: invite.emailError,
    ...(auditErr ? { warning: 'Invite sent, but the audit log entry could not be written. Tell Mirae.' } : {})
  })
}
