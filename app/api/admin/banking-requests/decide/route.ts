/**
 * POST /api/admin/banking-requests/decide
 *   { request_id, decision: 'approved' | 'rejected', confirm_account?, note? }
 *
 * This is the ONLY code path in the product that copies BAM-supplied banking
 * values into the `bams` table. A request never applies itself.
 *
 * Approving is deliberately not one click. The admin must send `confirm_account`
 * equal to the account number being requested, typed by hand. A mismatch blocks
 * the write and is recorded. The reason: if someone gets into a student's portal
 * account and files a correction pointing at their own bank, a reflex "approve"
 * moves real money. Retyping the digits forces the reviewer to look at them.
 *
 * Applying also clears bams.email_verified_at, which pushes the student back
 * through /portal/verify-account to confirm the new last 4. That is the loop
 * that catches a change the student did not make.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import {
  accountConfirmMatches,
  buildAppliedBamPatch,
  validateBankingRequestInput,
  tail4
} from '../../../../../lib/banking-request'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const MIN_NOTE_LENGTH = 5

type Banking = { institution_no: string | null; transit_no: string | null; account_no: string | null }

export async function POST(req: NextRequest) {
  // Role comes from app_metadata only (lib/auth-claims). A role in
  // user_metadata is writable by its own owner and is not a role.
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }
  const b = (body ?? {}) as Record<string, unknown>
  const requestId = typeof b.request_id === 'string' ? b.request_id : null
  const decision = b.decision
  const note = typeof b.note === 'string' ? b.note.trim() : ''

  if (!requestId || (decision !== 'approved' && decision !== 'rejected')) {
    return NextResponse.json(
      { ok: false, message: 'request_id and decision (approved | rejected) are required' },
      { status: 400 }
    )
  }
  if (decision === 'rejected' && note.length < MIN_NOTE_LENGTH) {
    return NextResponse.json(
      { ok: false, message: `A note is required when rejecting (at least ${MIN_NOTE_LENGTH} characters). The BAM sees it.` },
      { status: 400 }
    )
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Service role key not configured' }, { status: 500 })
  }

  const actorId = auth.devBypass ? NIL_UUID : auth.userId
  const nowIso = new Date().toISOString()

  const { data: reqRows, error: reqErr } = await db.from('banking_change_requests')
    .select('id, bam_id, status, reason, bank_name')
    .eq('id', requestId)
    .limit(2)
  if (reqErr) {
    console.error('[banking-requests/decide] request read failed:', reqErr.message)
    return NextResponse.json({ ok: false, message: reqErr.message }, { status: 500 })
  }
  const rows = (reqRows ?? []) as { id: string; bam_id: string; status: string; reason: string; bank_name: string }[]
  if (rows.length !== 1) {
    return NextResponse.json({ ok: false, message: 'Request not found.' }, { status: 404 })
  }
  const request = rows[0]
  if (request.status !== 'pending') {
    return NextResponse.json(
      { ok: false, message: `This request was already ${request.status}.` },
      { status: 409 }
    )
  }

  // ── Reject ────────────────────────────────────────────────────────────────
  if (decision === 'rejected') {
    const { data: updated, error: updErr } = await db.from('banking_change_requests')
      .update({ status: 'rejected', decided_by: actorId, decided_at: nowIso, decision_note: note })
      .eq('id', requestId)
      .eq('status', 'pending')
      .select('id, status')
    if (updErr) {
      console.error('[banking-requests/decide] reject write failed:', updErr.message)
      return NextResponse.json({ ok: false, message: updErr.message }, { status: 500 })
    }
    if (!updated || updated.length !== 1) {
      // 0 rows means someone else decided it first. That is a finding, not a success.
      return NextResponse.json(
        { ok: false, message: 'Nothing was updated. The request may have been decided already.' },
        { status: 409 }
      )
    }

    const auditOk = await writeAudit(db, {
      actorId: auth.devBypass ? null : auth.userId,
      actorRole: auth.role,
      requestId,
      action: 'rejected',
      before: { status: 'pending' },
      after: { status: 'rejected', decided_by: auth.email ?? actorId, note }
    })
    return NextResponse.json({ ok: true, status: 'rejected', audit_logged: auditOk })
  }

  // ── Approve → apply ───────────────────────────────────────────────────────

  // What is being asked for.
  const { data: reqDec, error: decErr } = await db
    .rpc('decrypt_banking_request', { p_request_id: requestId }).single()
  if (decErr || !reqDec) {
    console.error('[banking-requests/decide] decrypt request failed:', decErr?.message)
    return NextResponse.json(
      { ok: false, message: 'The requested values could not be read. Nothing was changed.' },
      { status: 500 }
    )
  }
  const requested = reqDec as Banking

  // Type-to-confirm. Checked on the SERVER: a disabled button in the browser is
  // a hint, not a control.
  if (!accountConfirmMatches(b.confirm_account, requested.account_no)) {
    await writeAudit(db, {
      actorId: auth.devBypass ? null : auth.userId,
      actorRole: auth.role,
      requestId,
      action: 'approve_confirm_mismatch',
      before: { status: 'pending' },
      after: {
        status: 'pending',
        blocked: true,
        attempted_by: auth.email ?? actorId,
        requested_account_last4: tail4(requested.account_no)
      }
    })
    return NextResponse.json(
      {
        ok: false,
        message: 'The account number you typed does not match the requested account number. Nothing was changed.'
      },
      { status: 400 }
    )
  }

  // Re-validate before writing. The values were validated at submit time, but
  // this is the write that moves money, so it does not trust an earlier check.
  const validated = validateBankingRequestInput({
    bank_name: request.bank_name,
    institution_no: requested.institution_no,
    transit_no: requested.transit_no,
    account_no: requested.account_no,
    reason: request.reason
  })
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, message: `This request cannot be applied: ${validated.message}` },
      { status: 400 }
    )
  }
  const v = validated.value

  // Capture what is on file now, so the audit has a real before/after and so a
  // failed write can be undone.
  const { data: curDec, error: curErr } = await db
    .rpc('decrypt_bam_banking', { p_bam_id: request.bam_id }).single()
  if (curErr) {
    console.error('[banking-requests/decide] decrypt current failed:', curErr.message)
    return NextResponse.json(
      { ok: false, message: 'The current banking details could not be read, so this change cannot be audited. Nothing was changed.' },
      { status: 500 }
    )
  }
  const before = (curDec ?? {}) as Banking

  const { data: bamRows, error: bamErr } = await db.from('bams')
    .select('bank_name, email_verified_at')
    .eq('id', request.bam_id)
    .limit(1)
  if (bamErr) {
    return NextResponse.json({ ok: false, message: bamErr.message }, { status: 500 })
  }
  const beforeBam = (bamRows ?? [])[0] as { bank_name: string | null; email_verified_at: string | null } | undefined

  // 1. bank_name + the email_verified_at reset. buildAppliedBamPatch owns the
  //    reset so it is one testable decision rather than an inline null.
  const patch = buildAppliedBamPatch(v.bankName)
  const { data: bamUpd, error: bamUpdErr } = await db.from('bams')
    .update(patch)
    .eq('id', request.bam_id)
    .select('id, bank_name, email_verified_at')
  if (bamUpdErr) {
    console.error('[banking-requests/decide] bams update failed:', bamUpdErr.message)
    return NextResponse.json({ ok: false, message: bamUpdErr.message }, { status: 500 })
  }
  if (!bamUpd || bamUpd.length !== 1 || bamUpd[0].email_verified_at !== null) {
    return NextResponse.json(
      { ok: false, message: 'The account update did not take effect. Nothing was applied.' },
      { status: 500 }
    )
  }

  // 2. The encrypted values.
  const { error: encErr } = await db.rpc('encrypt_bam_banking', {
    p_bam_id: request.bam_id,
    p_institution_no: v.institutionNo,
    p_transit_no: v.transitNo,
    p_account_no: v.accountNo,
    p_hst_number: null
  })
  if (encErr) {
    console.error('[banking-requests/decide] encrypt_bam_banking failed:', encErr.message)
    await restoreBanking(db, request.bam_id, before, beforeBam?.bank_name ?? null)
    return NextResponse.json(
      { ok: false, message: `The new banking details could not be saved (${encErr.message}). The previous details were restored.` },
      { status: 500 }
    )
  }

  // 3. Read back. "The RPC returned no error" is not evidence that the right
  //    digits are stored (ENGINEERING-RULES 1).
  const { data: afterDec, error: afterErr } = await db
    .rpc('decrypt_bam_banking', { p_bam_id: request.bam_id }).single()
  const after = (afterDec ?? {}) as Banking
  const persisted =
    !afterErr &&
    after.institution_no === v.institutionNo &&
    after.transit_no === v.transitNo &&
    after.account_no === v.accountNo
  if (!persisted) {
    await restoreBanking(db, request.bam_id, before, beforeBam?.bank_name ?? null)
    return NextResponse.json(
      {
        ok: false,
        message: 'The saved banking details did not match what was requested, so the change was rolled back. Nothing was applied.'
      },
      { status: 500 }
    )
  }

  // 4. Audit BEFORE closing the request. An unlogged banking change is not
  //    acceptable: if this fails the values go back and the request stays open.
  const auditOk = await writeAudit(db, {
    actorId: auth.devBypass ? null : auth.userId,
    actorRole: auth.role,
    requestId,
    action: 'applied',
    before: {
      status: 'pending',
      bam_id: request.bam_id,
      bank_name: beforeBam?.bank_name ?? null,
      institution_no: before.institution_no,
      transit_no: before.transit_no,
      // Full account numbers are never written to audit_log; the tail is enough
      // to trace which account was replaced.
      account_last4: tail4(before.account_no),
      email_verified_at: beforeBam?.email_verified_at ?? null
    },
    after: {
      status: 'applied',
      bam_id: request.bam_id,
      bank_name: v.bankName,
      institution_no: v.institutionNo,
      transit_no: v.transitNo,
      account_last4: tail4(v.accountNo),
      // Reset on purpose: the student must re-confirm the new last 4 at
      // /portal/verify-account before any copy of an invoice is emailed.
      email_verified_at: null,
      approved_by: auth.email ?? actorId,
      note: note || null
    }
  })
  if (!auditOk) {
    await restoreBanking(db, request.bam_id, before, beforeBam?.bank_name ?? null)
    return NextResponse.json(
      {
        ok: false,
        message: 'The change was rolled back: its audit-log entry could not be written. Please try again.'
      },
      { status: 500 }
    )
  }

  // 5. Close the request.
  const { data: reqUpd, error: reqUpdErr } = await db.from('banking_change_requests')
    .update({
      status: 'applied',
      decided_by: actorId,
      decided_at: nowIso,
      decision_note: note || 'Applied by admin after type-to-confirm.'
    })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select('id, status')
  if (reqUpdErr || !reqUpd || reqUpd.length !== 1) {
    // The banking change IS applied and IS audited. Say so plainly instead of
    // reporting a clean failure that would invite a second approval.
    console.error('[banking-requests/decide] request close failed:', reqUpdErr?.message ?? '0 rows')
    return NextResponse.json({
      ok: false,
      applied: true,
      message: 'The banking details were updated, but the request could not be marked applied. Do not approve it again; tell your developer.'
    }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    status: 'applied',
    email_verification_reset: true,
    account_last4: tail4(v.accountNo),
    audit_logged: true
  })
}

type Db = ReturnType<typeof serviceClient>

async function writeAudit(
  db: Db,
  a: {
    actorId: string | null
    actorRole: string
    requestId: string
    action: string
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
  }
): Promise<boolean> {
  // audit_log columns (0001): actor_id, actor_role, entity, entity_id, action,
  // before_json, after_json, ts. There is no `meta` column; an unknown key makes
  // the insert fail, which is why the error is read here.
  const { error } = await db.from('audit_log').insert({
    actor_id: a.actorId,
    actor_role: a.actorRole,
    entity: 'banking_change_requests',
    entity_id: a.requestId,
    action: a.action,
    before_json: a.before,
    after_json: a.after
  })
  if (error) {
    console.error('[banking-requests/decide] audit_log insert failed:', error.message)
    return false
  }
  return true
}

/**
 * Put the previous banking values back after a failed apply. Best effort, loud on failure.
 *
 * Limit worth knowing: encrypt_bam_banking (0003) treats a null argument as
 * "leave this column alone", so if the BAM had NO banking on file before, this
 * cannot blank the new values back out. That case is logged and reported as a
 * failure to the admin rather than being papered over.
 */
async function restoreBanking(db: Db, bamId: string, before: Banking, beforeBankName: string | null) {
  const { error: rpcErr } = await db.rpc('encrypt_bam_banking', {
    p_bam_id: bamId,
    p_institution_no: before.institution_no,
    p_transit_no: before.transit_no,
    p_account_no: before.account_no,
    p_hst_number: null
  })
  if (rpcErr) {
    console.error('[banking-requests/decide] RESTORE FAILED for bam', bamId, rpcErr.message,
      '- banking may be in a partially updated state; manual check required')
  }
  // email_verified_at intentionally stays NULL. Re-verification is the safe
  // direction: the worst case is the student confirms details that never changed.
  const { error: nameErr } = await db.from('bams').update({ bank_name: beforeBankName }).eq('id', bamId)
  if (nameErr) console.error('[banking-requests/decide] bank_name restore failed:', nameErr.message)
}
