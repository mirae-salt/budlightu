/**
 * POST /api/admin/unmatched/resolve  { submission_id, corrected_email }
 *
 * Clears a parked onboarding submission by DOING THE WORK: correcting the roster
 * email so the student can finish onboarding. Replaces the client-side write in
 * app/admin/unmatched/page.tsx, which
 *   - never read the corrected email the admin typed,
 *   - wrote with the browser anon key while `onboarding_submissions` is
 *     super-admin-only under RLS (0002_rls_policies.sql), so a program_admin's
 *     UPDATE matched zero rows and PostgREST still returned success,
 *   - checked neither `error` nor rows-affected,
 *   - and reported an unconditional green "Roster updated" while the student
 *     stayed locked out of login, receipt upload and payment.
 *
 * The target BAM is derived server-side (see lib/unmatched-resolve.ts). The body
 * cannot name a BAM, so a submission can never be pointed at the wrong one; if
 * the target is not unambiguous the request is refused with the reason.
 *
 * Authorization is requireAdmin(), matching GET /api/admin/data?table=unmatched
 * which already lets a program_admin see this queue.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import { isUuid } from '../../../../../lib/admin-input'
import { normalizeEmail } from '../../../../../lib/sanitize'
import {
  planUnmatchedResolution,
  rosterEmailFromFlagReason,
  type BamCandidate,
  type SubmissionRow
} from '../../../../../lib/unmatched-resolve'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }
  const { submission_id, corrected_email } = (body ?? {}) as Record<string, unknown>

  if (!isUuid(submission_id)) {
    return NextResponse.json({ ok: false, message: 'submission_id required' }, { status: 400 })
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  // ── 1. Load the submission (array, not .single(): 0 rows and 2 rows are
  //       different answers and .maybeSingle() hides the second one) ──────────
  const { data: subRows, error: subErr } = await db
    .from('onboarding_submissions')
    .select('id, status, matched_bam_id, flag_reason, submitted_email')
    .eq('id', submission_id)

  if (subErr) {
    return NextResponse.json({ ok: false, message: `Could not read the submission: ${subErr.message}` }, { status: 500 })
  }
  if (!subRows || subRows.length !== 1) {
    return NextResponse.json({ ok: false, message: 'That submission no longer exists.' }, { status: 404 })
  }
  const submission = subRows[0] as SubmissionRow & { status: string }

  if (submission.status !== 'unmatched') {
    return NextResponse.json(
      { ok: false, message: `This submission is already ${submission.status}. Reload the page.` },
      { status: 409 }
    )
  }

  // ── 2. Candidate roster rows, looked up server-side only ───────────────────
  let candidates: BamCandidate[] = []
  if (submission.matched_bam_id) {
    const { data, error } = await db.from('bams').select('id, email, status').eq('id', submission.matched_bam_id)
    if (error) {
      return NextResponse.json({ ok: false, message: `Could not read the roster: ${error.message}` }, { status: 500 })
    }
    candidates = (data ?? []) as BamCandidate[]
  } else {
    const rosterEmail = rosterEmailFromFlagReason(submission.flag_reason)
    if (rosterEmail) {
      // ilike with no wildcard is case-insensitive equality. A roster email
      // holding an invisible character will not match, which surfaces as the
      // "no roster row has that email" refusal rather than a wrong guess.
      const { data, error } = await db.from('bams').select('id, email, status').ilike('email', rosterEmail).limit(5)
      if (error) {
        return NextResponse.json({ ok: false, message: `Could not read the roster: ${error.message}` }, { status: 500 })
      }
      candidates = (data ?? []) as BamCandidate[]
    }
  }

  const plan = planUnmatchedResolution({ submission, candidates, correctedEmail: corrected_email })
  if (!plan.ok) {
    return NextResponse.json({ ok: false, message: plan.message }, { status: plan.status })
  }

  // ── 3. Correct the roster email, if that is what is needed ─────────────────
  if (plan.emailChange) {
    const { data: clash, error: clashErr } = await db
      .from('bams')
      .select('id')
      .ilike('email', plan.emailChange.to)
      .neq('id', plan.bamId)
      .limit(1)
    if (clashErr) {
      return NextResponse.json({ ok: false, message: `Could not check for a duplicate email: ${clashErr.message}` }, { status: 500 })
    }
    if (clash && clash.length > 0) {
      return NextResponse.json(
        { ok: false, message: `Another BAM already uses ${plan.emailChange.to}. Nothing was changed.` },
        { status: 409 }
      )
    }

    // `.eq('status','pending')` is a compare-and-set: if the BAM was activated
    // between the plan and this write, 0 rows change and we say so.
    const { data: updated, error: updErr } = await db
      .from('bams')
      .update({ email: plan.emailChange.to })
      .eq('id', plan.bamId)
      .eq('status', 'pending')
      .select('id, email, status')

    if (updErr) {
      return NextResponse.json({ ok: false, message: `Roster update failed: ${updErr.message}` }, { status: 500 })
    }
    if (!updated || updated.length !== 1) {
      return NextResponse.json(
        {
          ok: false,
          message: `The roster row was not updated (${updated?.length ?? 0} rows changed). It may no longer be pending. Nothing was resolved.`
        },
        { status: 409 }
      )
    }
    // Read-back (ENGINEERING-RULES 1): a DB trigger normalizes email on write,
    // so confirm the stored value is the one we asked for before claiming it.
    const saved = updated[0] as { email: string | null }
    if (normalizeEmail(saved.email) !== plan.emailChange.to) {
      console.error(
        `[unmatched/resolve] email read-back mismatch on bam ${plan.bamId}: ` +
        `wrote "${plan.emailChange.to}", stored "${normalizeEmail(saved.email)}"`
      )
      return NextResponse.json(
        { ok: false, message: 'The saved email did not match what was submitted. Check the value and try again.' },
        { status: 500 }
      )
    }
  }

  // ── 4. Only now close the queue item ───────────────────────────────────────
  const resolvedAt = new Date().toISOString()
  const { data: closed, error: closeErr } = await db
    .from('onboarding_submissions')
    .update({ status: 'resolved', resolved_at: resolvedAt, matched_bam_id: plan.bamId })
    .eq('id', submission.id)
    .eq('status', 'unmatched')
    .select('id, status, matched_bam_id')

  if (closeErr || !closed || closed.length !== 1) {
    const why = closeErr?.message ?? `${closed?.length ?? 0} rows changed`
    const emailPart = plan.emailChange
      ? `The roster email WAS corrected to ${plan.emailChange.to}. `
      : ''
    return NextResponse.json(
      {
        ok: false,
        message: `${emailPart}The submission could not be marked resolved (${why}). It is still in the queue. Tell Mirae.`
      },
      { status: 500 }
    )
  }

  // ── 5. Audit with the real column shape. There is NO `meta` column and
  //       actor_id is a uuid: a wrong shape is rejected and, if the error is
  //       discarded, nothing is ever recorded (the bulk-invite bug). ──────────
  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'onboarding_submissions',
    entity_id: submission.id,
    action: 'resolve_unmatched',
    before_json: {
      status: 'unmatched',
      matched_bam_id: submission.matched_bam_id,
      bam_email: plan.emailChange ? plan.emailChange.from : plan.correctedEmail
    },
    after_json: {
      status: 'resolved',
      matched_bam_id: plan.bamId,
      bam_email: plan.correctedEmail,
      email_changed: Boolean(plan.emailChange),
      target_resolved_via: plan.via
    }
  })
  if (auditErr) console.error('[unmatched/resolve] audit_log insert failed:', auditErr.message)

  return NextResponse.json({
    ok: true,
    submission_id: submission.id,
    bam_id: plan.bamId,
    email_changed: Boolean(plan.emailChange),
    message: plan.emailChange
      ? `Roster email changed to ${plan.emailChange.to}. Ask the student to open their original invite link again.`
      : `Roster already had ${plan.correctedEmail}, so no email was changed. Submission closed and linked to that BAM.`,
    ...(auditErr ? { warning: 'The change was made but the audit log entry failed. Tell Mirae.' } : {})
  })
}
