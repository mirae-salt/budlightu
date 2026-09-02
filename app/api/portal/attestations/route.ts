/**
 * The three setup statements, for people who onboarded before we asked.
 *
 *   GET  /api/portal/attestations  -> which ones are still missing
 *   POST /api/portal/attestations  -> record them
 *
 * Everyone onboarding from 2026-09-02 answers these on the onboarding form. This route
 * exists for the students who finished onboarding before the questions existed: without
 * it they would never be asked, and their rows would stay empty forever with no way to
 * fill them. Three real students are in that position today.
 *
 * The BAM is resolved from the DATABASE via requireBam() (bams.auth_user_id), never from
 * JWT metadata the student's own session can write.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireBam, denied } from '../../../../lib/admin-auth'
import { validateAttestations, ATTESTATION_VERSION } from '../../../../lib/attestations'

export async function GET() {
  const auth = await requireBam()
  if (!auth.ok) return denied(auth)

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data, error } = await db.from('bams')
    .select('work_auth_attested_at, banking_attested_at, consent_ai_training')
    .eq('id', auth.bamId)
    .maybeSingle()

  if (error || !data) {
    /*
     * Fail CLOSED on the prompt, which here means NOT prompting. If the row cannot be
     * read we do not know whether they already answered, and a modal that reappears
     * every visit for someone who already ticked it is worse than a delayed question:
     * the answer is only missing for three people and they will be asked next time.
     */
    console.error('[portal/attestations] read failed:', error?.message ?? 'no row')
    return NextResponse.json({ ok: true, needed: false, degraded: true })
  }

  const needed = !data.work_auth_attested_at || !data.banking_attested_at
  return NextResponse.json({
    ok: true,
    needed,
    // Only ask the optional one while it has never been answered either way.
    askAiTraining: data.consent_ai_training === null || data.consent_ai_training === undefined
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireBam()
  if (!auth.ok) return denied(auth)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }

  const checked = validateAttestations({
    workAuth: body.work_auth,
    bankingOwner: body.banking_owner,
    aiTraining: body.ai_training
  })
  if (!checked.ok) {
    return NextResponse.json({ ok: false, message: checked.error }, { status: 400 })
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = {
    work_auth_attested_at: now,
    work_auth_version: ATTESTATION_VERSION,
    banking_attested_at: now,
    banking_version: ATTESTATION_VERSION
  }
  // Only written when they actually answered, so "declined" and "never asked" stay
  // distinguishable in the column.
  if (checked.aiTraining !== null) {
    patch.consent_ai_training = checked.aiTraining
    patch.consent_ai_training_at = now
    patch.consent_ai_training_version = ATTESTATION_VERSION
  }

  const { error } = await db.from('bams').update(patch).eq('id', auth.bamId)
  if (error) {
    console.error('[portal/attestations] write failed:', error.message)
    return NextResponse.json({ ok: false, message: 'Could not save that. Try again.' }, { status: 500 })
  }

  // Read back. This is a record of something a person agreed to, so "the client did not
  // throw" is not good enough evidence that it is on the row.
  const { data: after, error: readErr } = await db.from('bams')
    .select('work_auth_attested_at, work_auth_version, banking_attested_at, consent_ai_training')
    .eq('id', auth.bamId)
    .maybeSingle()

  if (readErr || !after?.work_auth_attested_at || !after?.banking_attested_at) {
    console.error('[portal/attestations] read-back mismatch:', readErr?.message ?? JSON.stringify(after))
    return NextResponse.json(
      { ok: false, message: 'Saved, but we could not confirm it. Tell your program contact.' },
      { status: 500 }
    )
  }

  /*
   * Logged, because this path is different from onboarding. At onboarding the columns
   * ARE the original record and there is nothing to compare them against. Here an
   * existing row is being changed later, by the student rather than an admin, which is
   * the thing audit_log is for. It also means Mirae and Shane can see who answered the
   * catch-up prompt without a new admin screen.
   *
   * Logged from the read-back, so the entry records what is on the row rather than what
   * was posted. A failure to log is not a failure to attest: the attestation is already
   * stored and confirmed, so this only warns.
   */
  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: 'bam',
    entity: 'bams',
    entity_id: auth.bamId,
    action: 'attestations_recorded',
    before_json: { source: 'catch-up prompt, onboarded before these questions existed' },
    after_json: {
      work_auth_attested_at: after.work_auth_attested_at,
      banking_attested_at: after.banking_attested_at,
      consent_ai_training: after.consent_ai_training ?? null,
      version: after.work_auth_version
    }
  })
  if (auditErr) console.error('[portal/attestations] audit_log insert failed:', auditErr.message)

  return NextResponse.json({
    ok: true,
    version: after.work_auth_version,
    aiTraining: after.consent_ai_training ?? null
  })
}
