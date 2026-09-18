/**
 * POST /api/admin/banking
 *   { bam_id, bank_name, institution_no, transit_no, account_no, reason }
 *
 * Raise a banking correction ON BEHALF OF a BAM, from the roster screen.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026-09-17 the only way in was the student filing it from their own portal.
 * That is the right default and it stays the default. It stopped being sufficient on
 * the day it had to: Lauren Burnett flagged an extra digit in her account number on the
 * invoice thread, the AP send was already due, and nothing could move until she logged
 * in and retyped the number into a form. Robin had the corrected number in front of her
 * and no way to use it.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does NOT apply anything. It writes one pending row to banking_change_requests,
 * encrypted, exactly as the student's own submission does, and the admin then approves
 * it on /admin/banking-requests with the existing type-to-confirm.
 *
 * That second step is the whole design and it is not ceremony. The protection against a
 * typo in an account number has never been who types it, it is that the digits are
 * entered twice and compared. Letting one form write straight into `bams` would have
 * removed the only check that exists, on the field where a single wrong character pays
 * a stranger. Two screens the admin already knows costs about fifteen seconds.
 *
 * Applying it also emails the BAM and posts to their bell (decide route, step 7), so a
 * change they did not ask for does not happen silently.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import { validateBankingRequestInput, tail4 } from '../../../../lib/banking-request'

const MIN_REASON = 5

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }
  const b = (body ?? {}) as Record<string, unknown>
  const bamId = typeof b.bam_id === 'string' ? b.bam_id.trim() : ''
  if (!bamId) {
    return NextResponse.json({ ok: false, message: 'bam_id is required' }, { status: 400 })
  }

  // The reason is not paperwork. In three months this row is the only account of why
  // someone's payment destination moved, and "the student said so on the thread" is a
  // materially different answer from "an email asked us to".
  const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
  if (reason.length < MIN_REASON) {
    return NextResponse.json({
      ok: false,
      message: `Say where these numbers came from, in at least ${MIN_REASON} characters. ` +
        'This is the record of why someone\'s payment destination changed.'
    }, { status: 400 })
  }

  // Same validator the student's submission uses. Values stay strings throughout:
  // a transit number that passes through a number type loses its leading zero.
  const validated = validateBankingRequestInput({
    bank_name: b.bank_name,
    institution_no: b.institution_no,
    transit_no: b.transit_no,
    account_no: b.account_no,
    reason
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

  const { data: bamRows, error: bamErr } = await db.from('bams')
    .select('id, first_name, last_name')
    .eq('id', bamId)
    .limit(1)
  if (bamErr) {
    return NextResponse.json({ ok: false, message: `Could not read that BAM: ${bamErr.message}` }, { status: 500 })
  }
  const bam = (bamRows ?? [])[0] as { id: string; first_name: string; last_name: string } | undefined
  if (!bam) {
    return NextResponse.json({ ok: false, message: 'That BAM does not exist. Reload the page.' }, { status: 404 })
  }

  // Encrypted insert. The plaintext exists only inside this call. The RPC checks the
  // caller's role itself (0022), so the p_bam_id here is not a hole.
  const { data: newId, error: encErr } = await db.rpc('encrypt_banking_request', {
    p_bam_id: bamId,
    p_reason: `[raised by ${auth.email ?? 'an admin'}] ${v.reason}`,
    p_bank_name: v.bankName,
    p_institution_no: v.institutionNo,
    p_transit_no: v.transitNo,
    p_account_no: v.accountNo
  })
  if (encErr) {
    // 23505 = the one-pending-per-BAM partial unique index.
    const duplicate = (encErr as { code?: string }).code === '23505'
      || /banking_change_requests_one_pending/.test(encErr.message)
    if (duplicate) {
      return NextResponse.json({
        ok: false,
        message: `${bam.first_name} already has a banking change waiting for review. Decide that one first on the Banking requests page.`
      }, { status: 409 })
    }
    console.error('[admin/banking] encrypted insert failed:', encErr.message)
    return NextResponse.json({ ok: false, message: 'The correction could not be saved.' }, { status: 500 })
  }
  const requestId = typeof newId === 'string' ? newId : null
  if (!requestId) {
    // "no error" is not "a row exists" (ENGINEERING-RULES 3).
    console.error('[admin/banking] encrypt_banking_request returned no id')
    return NextResponse.json({
      ok: false,
      message: 'We could not confirm the correction was saved. Check the Banking requests page before trying again.'
    }, { status: 500 })
  }

  // Only the last 4 digits. audit_log is read by more people than the banking columns
  // are, and a full account number in it is a second plaintext copy of the PII.
  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'banking_change_requests',
    entity_id: requestId,
    action: 'submitted_by_admin',
    before_json: null,
    after_json: {
      bam_id: bamId,
      status: 'pending',
      bank_name: v.bankName,
      account_last4: tail4(v.accountNo),
      institution_mismatch: v.institutionMismatch,
      raised_by: auth.email ?? auth.userId,
      reason: v.reason
    }
  })
  if (auditErr) {
    console.error('[admin/banking] audit_log insert failed:', auditErr.message)
  }

  return NextResponse.json({
    ok: true,
    request_id: requestId,
    account_last4: tail4(v.accountNo),
    audit_logged: !auditErr,
    // Said plainly so nobody closes the tab thinking the banking is fixed.
    message: `Correction saved for ${bam.first_name} ${bam.last_name}. It is NOT applied yet — ` +
      'approve it on the Banking requests page, where you retype the account number to confirm it.'
  })
}
