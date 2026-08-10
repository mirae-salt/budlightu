/**
 * POST /api/admin/unmatched/reject  { submission_id, reason }
 *
 * Same failure as the resolve path: the page wrote `status:'rejected'` with the
 * browser anon key against a super-admin-only table, checked neither `error` nor
 * rows-affected, recorded no reason and no audit entry, and reported green.
 *
 * A reason is now required and is appended to `flag_reason` (the original
 * mismatch text is kept, never overwritten) so the row still explains itself
 * without a schema change.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import { isUuid } from '../../../../../lib/admin-input'
import { parseRejectReason } from '../../../../../lib/unmatched-resolve'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }
  const { submission_id, reason } = (body ?? {}) as Record<string, unknown>

  if (!isUuid(submission_id)) {
    return NextResponse.json({ ok: false, message: 'submission_id required' }, { status: 400 })
  }
  const parsed = parseRejectReason(reason)
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, message: parsed.message }, { status: 400 })
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data: subRows, error: subErr } = await db
    .from('onboarding_submissions')
    .select('id, status, flag_reason, matched_bam_id')
    .eq('id', submission_id)

  if (subErr) {
    return NextResponse.json({ ok: false, message: `Could not read the submission: ${subErr.message}` }, { status: 500 })
  }
  if (!subRows || subRows.length !== 1) {
    return NextResponse.json({ ok: false, message: 'That submission no longer exists.' }, { status: 404 })
  }
  const submission = subRows[0] as { id: string; status: string; flag_reason: string | null }

  if (submission.status !== 'unmatched') {
    return NextResponse.json(
      { ok: false, message: `This submission is already ${submission.status}. Reload the page.` },
      { status: 409 }
    )
  }

  const original = submission.flag_reason ?? ''
  const flagReason = `${original ? original + ' | ' : ''}rejected: ${parsed.reason}`

  const { data: updated, error: updErr } = await db
    .from('onboarding_submissions')
    .update({ status: 'rejected', resolved_at: new Date().toISOString(), flag_reason: flagReason })
    .eq('id', submission.id)
    .eq('status', 'unmatched')
    .select('id, status')

  if (updErr) {
    return NextResponse.json({ ok: false, message: `Reject failed: ${updErr.message}` }, { status: 500 })
  }
  if (!updated || updated.length !== 1) {
    return NextResponse.json(
      { ok: false, message: `Nothing was rejected (${updated?.length ?? 0} rows changed). Reload the page.` },
      { status: 409 }
    )
  }

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'onboarding_submissions',
    entity_id: submission.id,
    action: 'reject_unmatched',
    before_json: { status: 'unmatched', flag_reason: original },
    after_json: { status: 'rejected', reason: parsed.reason }
  })
  if (auditErr) console.error('[unmatched/reject] audit_log insert failed:', auditErr.message)

  return NextResponse.json({
    ok: true,
    submission_id: submission.id,
    message: 'Submission rejected. The reason is on the record.',
    ...(auditErr ? { warning: 'The change was made but the audit log entry failed. Tell Mirae.' } : {})
  })
}
