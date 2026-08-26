/**
 * POST   /api/admin/cohorts/member  { bam_id, cohort_id }  — move a BAM to a cohort
 * DELETE /api/admin/cohorts/member  { bam_id }             — archive a BAM
 *
 * P0-A: the local `requireAdmin()` here read `user_metadata.role`, which the
 * user's own session can write, and returned a caller id for ANY request while
 * NODE_ENV was development (no ALLOW_DEV_AUTH_BYPASS gate). Replaced with the
 * shared helper, which reads app_metadata only and fails closed.
 *
 * "REMOVE FROM COHORT" DOES NOT EXIST, and used to fail every time.
 * ----------------------------------------------------------------
 * DELETE used to write `cohort_id: null`, but `bams.cohort_id` is NOT NULL, so the
 * request always failed with "null value in column cohort_id violates not-null
 * constraint" — and the page rendered that in a green badge, so it looked like a
 * save. Every BAM belongs to exactly one cohort (fall 2026, summer 2026, ...), so
 * there is no state where a BAM exists outside one.
 *
 * What Robin actually means by "remove" is one of two things, and they are now
 * distinct operations:
 *   - they belong in a different cohort  -> POST with the new cohort_id
 *   - they are leaving the program       -> DELETE, which ARCHIVES them
 *
 * Archiving keeps `cohort_id` so the history of which cohort they were in survives,
 * and matches CLAUDE.md's soft-delete rule: there is no hard delete of a BAM.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import { testRowCohortProblem, isTestForCohort } from '../../../../../lib/admin-test-bam'

// `is_test` is in here because of audit finding 13: this route never read it, so it moved test
// accounts into live cohorts and walked straight around the guard on the roster screen. It is
// also the screen the September cutover uses to move the real roster in.
const READBACK = 'id, first_name, last_name, email, status, cohort_id, is_test'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: { bam_id?: string; cohort_id?: string }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, message: 'Invalid request body.' }, { status: 400 }) }

  const { bam_id, cohort_id } = body
  if (!bam_id || !cohort_id) {
    return NextResponse.json({ ok: false, message: 'bam_id and cohort_id are both required.' }, { status: 400 })
  }

  const admin = serviceClient()

  // Verify the cohort first, so a foreign-key violation never reaches the admin as
  // a raw Postgres string.
  const { data: cohort, error: cErr } = await admin
    .from('cohorts').select('id, name').eq('id', cohort_id).maybeSingle()
  if (cErr) return NextResponse.json({ ok: false, message: `Could not read that cohort: ${cErr.message}` }, { status: 500 })
  if (!cohort) return NextResponse.json({ ok: false, message: 'That cohort does not exist. Reload the page.' }, { status: 404 })

  const { data: before, error: bErr } = await admin
    .from('bams').select(READBACK).eq('id', bam_id).maybeSingle()
  if (bErr) return NextResponse.json({ ok: false, message: `Could not read that BAM: ${bErr.message}` }, { status: 500 })
  if (!before) return NextResponse.json({ ok: false, message: 'No roster row matched that id.' }, { status: 404 })

  // Moving someone into a TEST cohort makes them a test row, the same as adding them there
  // from the roster screen. Without this, a BAM dragged in here stayed is_test false and was
  // treated as a real BAM by the deadline rule and the invoice run.
  const resolvedIsTest = isTestForCohort(cohort.name, before.is_test === true)

  // AUDIT FINDING 13. A test account in a live cohort is picked up by the monthly invoice run
  // like anybody else, so it gets a real invoice addressed to AP. The roster screen has refused
  // this since it was written; this one did not, and this is the screen the cutover uses.
  const problem = testRowCohortProblem({
    isTest: resolvedIsTest,
    cohortName: cohort.name,
    cohortFound: true
  })
  if (problem) return NextResponse.json({ ok: false, message: problem }, { status: 409 })

  const move: Record<string, unknown> = { cohort_id }
  if (resolvedIsTest !== (before.is_test === true)) move.is_test = resolvedIsTest

  const { data: rows, error } = await admin
    .from('bams').update(move).eq('id', bam_id).select(READBACK)
  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  if (!rows || rows.length !== 1) {
    return NextResponse.json({ ok: false, message: `Move affected ${rows?.length ?? 0} rows, expected 1. Nothing was changed.` }, { status: 500 })
  }
  if (rows[0].cohort_id !== cohort_id) {
    return NextResponse.json({ ok: false, message: 'The move did not persist. Nothing was changed.' }, { status: 500 })
  }

  const { error: auditErr } = await admin.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'bams',
    entity_id: bam_id,
    action: 'cohort_move',
    before_json: { cohort_id: before.cohort_id },
    after_json: { cohort_id, cohort_name: cohort.name, moved_by: auth.email ?? null }
  })

  return NextResponse.json({
    ok: true,
    bam: rows[0],
    cohort_name: cohort.name,
    message: `${rows[0].first_name} ${rows[0].last_name} moved to ${cohort.name}.`,
    ...(auditErr ? { warning: 'Moved, but the audit log entry could not be written. Tell Mirae.' } : {})
  })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: { bam_id?: string }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, message: 'Invalid request body.' }, { status: 400 }) }

  const { bam_id } = body
  if (!bam_id) return NextResponse.json({ ok: false, message: 'bam_id is required.' }, { status: 400 })

  const admin = serviceClient()

  const { data: before, error: bErr } = await admin
    .from('bams').select(READBACK).eq('id', bam_id).maybeSingle()
  if (bErr) return NextResponse.json({ ok: false, message: `Could not read that BAM: ${bErr.message}` }, { status: 500 })
  if (!before) return NextResponse.json({ ok: false, message: 'No roster row matched that id.' }, { status: 404 })

  if (before.status === 'archived') {
    return NextResponse.json({
      ok: false,
      message: `${before.first_name} ${before.last_name} is already archived.`
    }, { status: 409 })
  }

  // Archive, keeping cohort_id: it is NOT NULL, and the record of which cohort
  // they were in is worth keeping. Compare-and-set on the status we read so two
  // admins clicking at once cannot both claim to have archived them.
  const { data: rows, error } = await admin
    .from('bams')
    .update({ status: 'archived' })
    .eq('id', bam_id)
    .eq('status', before.status)
    .select(READBACK)
  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  if (!rows || rows.length !== 1) {
    return NextResponse.json({ ok: false, message: 'Someone else changed this BAM just now. Reload and try again.' }, { status: 409 })
  }

  const { error: auditErr } = await admin.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'bams',
    entity_id: bam_id,
    action: 'archive',
    before_json: { status: before.status, cohort_id: before.cohort_id },
    after_json: { status: 'archived', cohort_id: before.cohort_id, archived_by: auth.email ?? null }
  })

  return NextResponse.json({
    ok: true,
    bam: rows[0],
    message: `${rows[0].first_name} ${rows[0].last_name} archived. They stay on the roster for the record, and no invoices will be generated for them.`,
    ...(auditErr ? { warning: 'Archived, but the audit log entry could not be written. Tell Mirae.' } : {})
  })
}
