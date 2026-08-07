/**
 * BAM side of the banking correction flow.
 *
 *   GET  /api/portal/banking-request  -> current bank on file + any open request
 *   POST /api/portal/banking-request  -> file a correction request
 *
 * This route CANNOT change anyone's banking. It writes one row to
 * banking_change_requests, encrypted, and notifies Robin. The only code that
 * touches bams banking columns is the admin decide route, and only after an
 * admin retypes the account number. See supabase/migrations/0022.
 *
 * The BAM is resolved from the DATABASE via requireBam() (bams.auth_user_id),
 * never from JWT metadata the student's own session can write (P0-A).
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireBam, denied } from '../../../../lib/admin-auth'
import { notifyAdmin } from '../../../../lib/notify-admin'
import {
  validateBankingRequestInput,
  checkRequestLimit,
  tail4,
  type ExistingRequest
} from '../../../../lib/banking-request'

/** Requests shown back to the student. Decision notes are included, values are not. */
const HISTORY_LIMIT = 5

export async function GET() {
  const auth = await requireBam()
  if (!auth.ok) return denied(auth)

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data: bamRows, error: bamErr } = await db.from('bams')
    .select('bank_name, email_verified_at')
    .eq('id', auth.bamId)
    .limit(1)
  if (bamErr) {
    console.error('[portal/banking-request] bam read failed:', bamErr.message)
    return NextResponse.json({ ok: false, message: 'Could not load your account.' }, { status: 500 })
  }
  const bam = (bamRows ?? [])[0] as { bank_name: string | null; email_verified_at: string | null } | undefined

  // Never select the encrypted columns here: the student's own values are not
  // readable back to them, and there is no reason to move ciphertext to a browser.
  const { data: reqRows, error: reqErr } = await db.from('banking_change_requests')
    .select('id, status, reason, bank_name, requested_at, decided_at, decision_note')
    .eq('bam_id', auth.bamId)
    .order('requested_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (reqErr) {
    console.error('[portal/banking-request] request read failed:', reqErr.message)
    return NextResponse.json({ ok: false, message: 'Could not load your requests.' }, { status: 500 })
  }

  const rows = (reqRows ?? []) as Array<{ id: string; status: string } & Record<string, unknown>>
  return NextResponse.json({
    ok: true,
    bank_name: bam?.bank_name ?? null,
    email_verified: Boolean(bam?.email_verified_at),
    pending: rows.find(r => r.status === 'pending') ?? null,
    history: rows
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireBam()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }
  const b = (body ?? {}) as Record<string, unknown>

  // Validation reuses lib/validation.ts. Values stay strings the whole way:
  // a leading zero dropped here is a payment sent to a different account.
  const validated = validateBankingRequestInput({
    bank_name: b.bank_name,
    institution_no: b.institution_no,
    transit_no: b.transit_no,
    account_no: b.account_no,
    reason: b.reason
  })
  if (!validated.ok) {
    return NextResponse.json({ ok: false, message: validated.message }, { status: 400 })
  }
  const v = validated.value

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const { data: existing, error: exErr } = await db.from('banking_change_requests')
    .select('status, requested_at')
    .eq('bam_id', auth.bamId)
    .order('requested_at', { ascending: false })
    .limit(50)
  if (exErr) {
    // Fail closed: if we cannot tell whether one is already open, do not open another.
    console.error('[portal/banking-request] existing lookup failed:', exErr.message)
    return NextResponse.json(
      { ok: false, message: 'We could not check your existing requests. Please try again shortly.' },
      { status: 503 }
    )
  }
  const limit = checkRequestLimit((existing ?? []) as ExistingRequest[])
  if (!limit.ok) {
    return NextResponse.json({ ok: false, message: limit.message }, { status: 409 })
  }

  const { data: bamRows, error: bamErr } = await db.from('bams')
    .select('first_name, last_name, cohort_id')
    .eq('id', auth.bamId)
    .limit(1)
  if (bamErr) {
    console.error('[portal/banking-request] bam read failed:', bamErr.message)
    return NextResponse.json({ ok: false, message: 'Could not load your account.' }, { status: 500 })
  }
  const bam = (bamRows ?? [])[0] as { first_name: string; last_name: string; cohort_id: string } | undefined
  const bamName = bam ? `${bam.first_name} ${bam.last_name}` : 'a BAM'

  // Encrypted insert. The plaintext exists only inside this function call.
  const { data: newId, error: encErr } = await db.rpc('encrypt_banking_request', {
    p_bam_id: auth.bamId,
    p_reason: v.reason,
    p_bank_name: v.bankName,
    p_institution_no: v.institutionNo,
    p_transit_no: v.transitNo,
    p_account_no: v.accountNo
  })
  if (encErr) {
    // 23505 = the one-pending partial unique index. Two tabs, one student.
    const isDuplicate = (encErr as { code?: string }).code === '23505'
      || /banking_change_requests_one_pending/.test(encErr.message)
    if (isDuplicate) {
      return NextResponse.json(
        { ok: false, message: 'You already have a banking change waiting for review.' },
        { status: 409 }
      )
    }
    console.error('[portal/banking-request] encrypted insert failed:', encErr.message)
    return NextResponse.json(
      { ok: false, message: 'We could not save your request. Please contact your program manager.' },
      { status: 500 }
    )
  }
  const requestId = typeof newId === 'string' ? newId : null
  if (!requestId) {
    // "no row returned" is a finding, not a success (ENGINEERING-RULES 3).
    console.error('[portal/banking-request] encrypt_banking_request returned no id')
    return NextResponse.json(
      { ok: false, message: 'We could not confirm your request was saved. Please contact your program manager.' },
      { status: 500 }
    )
  }

  // Audit: state change 1 of 2 (submitted). Column shape is fixed by 0001 --
  // actor_id, actor_role, entity, entity_id, action, before_json, after_json, ts.
  // There is no `meta` column; a wrong shape inserts nothing.
  //
  // Only the last 4 digits are recorded. The audit log is read by more people
  // than the banking columns are, and a full account number in it would be a
  // second copy of the PII in plaintext.
  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.userId,
    actor_role: 'bam',
    entity: 'banking_change_requests',
    entity_id: requestId,
    action: 'submitted',
    before_json: null,
    after_json: {
      bam_id: auth.bamId,
      status: 'pending',
      bank_name: v.bankName,
      account_last4: tail4(v.accountNo),
      institution_mismatch: v.institutionMismatch,
      reason: v.reason
    }
  })
  if (auditErr) {
    console.error('[portal/banking-request] audit_log insert failed:', auditErr.message)
  }

  const notif = await notifyAdmin({
    type: 'banking_change_request',
    title: `Banking change requested by ${bamName}`,
    body: v.reason.slice(0, 120),
    bam_id: auth.bamId,
    cohort_id: bam?.cohort_id,
    link: '/admin/banking-requests'
  })
  if (!notif.ok) {
    console.error('[portal/banking-request] admin notification not recorded:', notif.error)
  }

  return NextResponse.json({
    ok: true,
    request_id: requestId,
    audit_logged: !auditErr,
    admin_notified: notif.ok
  })
}
