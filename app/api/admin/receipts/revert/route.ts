/**
 * POST /api/admin/receipts/revert  { receipt_id, reason }
 *
 * Reopens a decided receipt so Robin can decide it again.
 *
 * Why this exists: a receipt decision used to be permanent. `decide` accepts only
 * pending/review/ocr_failed, the review queue lists only review/ocr_failed, and the
 * sha256 uniqueness index blocks re-uploading the same photo. So a mis-clicked
 * Reject cost the student their $150 with no recourse, and the admin UI's revert
 * button only mutated local React state, which looked like it worked and silently
 * did nothing after a refresh.
 *
 * Reverting also has to undo the money: approving a receipt writes a
 * reimbursement_ledger row, so reopening it must recompute that row from the
 * remaining approved receipts, or the ledger keeps paying for a receipt that is no
 * longer approved.
 */
import { NextRequest, NextResponse } from 'next/server'
import { reasonProblem } from '../../../../../lib/reason'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import { recomputeLedgerForPeriod } from '../../../../../lib/recompute-ledger'

/** Statuses that can be reopened. `pending` is already open. */
const REVERTIBLE = ['approved', 'rejected', 'auto_pass']

export async function POST(req: NextRequest) {
  const { receipt_id, reason } = await req.json()
  if (!receipt_id) {
    return NextResponse.json({ ok: false, message: 'receipt_id required' }, { status: 400 })
  }
  const reasonIssue = reasonProblem(reason, 'Reason for reopening')
  if (reasonIssue) {
    // Return the specific problem, not a generic line. The caller has no other way
    // to find out what the rule is.
    return NextResponse.json({ ok: false, message: reasonIssue }, { status: 400 })
  }

  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const admin = serviceClient()

  const { data: receipt, error: readErr } = await admin
    .from('receipts')
    .select('id, bam_id, cohort_id, period, status, bud_light_total_incl_tax, reverted_count, decided_by, decided_at, decision_reason, reverted_at, reverted_by')
    .eq('id', receipt_id)
    .maybeSingle()
  if (readErr) return NextResponse.json({ ok: false, error: readErr.message }, { status: 500 })
  if (!receipt) return NextResponse.json({ ok: false, message: 'receipt not found' }, { status: 404 })

  if (!REVERTIBLE.includes(receipt.status)) {
    return NextResponse.json(
      { ok: false, message: `Receipt is ${receipt.status} and is already open for a decision.` },
      { status: 409 }
    )
  }

  // The decision fields are in the select above because the rollback path restores
  // them. Leave them there: without them, `receipt.decided_by ?? null` is always null
  // and a rollback would wipe the decision instead of putting it back.
  const previousStatus: string = receipt.status

  // Compare-and-set on the status we read, so two admins clicking revert at the
  // same time cannot both win and double-decrement reverted_count.
  const { data: updated, error: updErr } = await admin
    .from('receipts')
    .update({
      status: 'review',
      decided_by: null,
      decided_at: null,
      decision_reason: `reopened by admin: ${String(reason).trim()}`,
      reverted_count: (receipt.reverted_count ?? 0) + 1,
      reverted_at: new Date().toISOString(),
      reverted_by: auth.devBypass ? null : auth.userId
    })
    .eq('id', receipt_id)
    .eq('status', previousStatus)
    .select('id, status')
  if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 })
  if (!updated || updated.length !== 1) {
    return NextResponse.json(
      { ok: false, message: 'Someone else changed this receipt just now. Refresh and try again.' },
      { status: 409 }
    )
  }

  // Audit BEFORE touching the ledger: an unlogged money change is not acceptable.
  const { error: auditErr } = await admin.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'receipts',
    entity_id: receipt_id,
    action: 'revert_decision',
    before_json: { status: previousStatus, bud_light_total_incl_tax: receipt.bud_light_total_incl_tax },
    after_json: { status: 'review', reason: String(reason).trim(), reverted_by: auth.email ?? null }
  })
  if (auditErr) {
    // Undo the reopen rather than leave an unlogged change behind.
    //
    // This used to be a bare `await` with no error binding and no read-back, and the
    // response said "revert rolled back" whether or not it had been. It also did not
    // restore decided_by / decided_at / decision_reason, so even a successful undo
    // left an approved receipt with no decider and a reason reading "reopened by
    // admin" -- the exact state the undo exists to prevent.
    const { data: restored, error: rbErr } = await admin.from('receipts')
      .update({
        status: previousStatus,
        decided_by: receipt.decided_by ?? null,
        decided_at: receipt.decided_at ?? null,
        decision_reason: receipt.decision_reason ?? null,
        reverted_count: receipt.reverted_count ?? 0,
        reverted_at: receipt.reverted_at ?? null,
        reverted_by: receipt.reverted_by ?? null
      })
      .eq('id', receipt_id)
      .select('id, status')

    const rolledBack = !rbErr && restored?.length === 1 && restored[0].status === previousStatus
    if (!rolledBack) {
      console.error(
        '[receipts/revert] ROLLBACK FAILED for receipt', receipt_id,
        rbErr?.message ?? `rows=${restored?.length ?? 0}`
      )
      return NextResponse.json(
        {
          ok: false,
          error: `The audit log write failed (${auditErr.message}) AND the rollback did not take. ` +
            'This receipt is reopened with no audit record. Do not act on it, and tell Mirae.'
        },
        { status: 500 }
      )
    }

    return NextResponse.json(
      { ok: false, error: `revert rolled back: audit log write failed (${auditErr.message})` },
      { status: 500 }
    )
  }

  // Recompute the ledger from what is still approved for this BAM/period.
  const ledger = await recomputeLedger(admin, receipt)

  /*
   * REBUILD THE DRAFT INVOICE FROM THE RECOMPUTED LEDGER.
   *
   * This was missing, and it is why "Batch approve failed (1 of 1 failed)" on 2026-08-13.
   * `decide` rebuilds the draft after it moves the ledger; this route moved the ledger and left
   * the document alone. So an approved receipt produced a draft carrying $58.45, reverting it
   * reset the ledger to $0, and the draft still said $58.45. Batch approve then refused with
   * "reimbursement on invoice does not match reimbursement_ledger.paid_cad", which is P0-D
   * working exactly as intended: it caught a document that disagreed with the money.
   *
   * But the operator had no way out. The error says "regenerate the invoice from the ledger"
   * and nothing in the UI does that, so touchpoint 2 was stuck until somebody edited the
   * database. A guard you cannot clear is an outage.
   *
   * Only drafts are touched: upsertDraftInvoice's update is `.eq('status','draft')`, so an
   * invoice already approved or sent is left alone and reported instead.
   *
   * Not fatal. The receipt IS reopened and the ledger IS correct at this point; a failure here
   * means the stale draft survives, which is the state we were already in and which batch
   * approve still refuses to send.
   */
  let invoiceRebuilt: boolean | null = null
  let invoiceError: string | undefined
  if (ledger.ok) {
    try {
      const { upsertDraftInvoice } = await import('@/lib/draft-invoice')
      const res = await upsertDraftInvoice(admin, receipt.bam_id, receipt.cohort_id, receipt.period)
      invoiceRebuilt = res.ok
      if (!res.ok) invoiceError = res.reason
    } catch (e) {
      invoiceRebuilt = false
      invoiceError = e instanceof Error ? e.message : String(e)
    }
    if (!invoiceRebuilt) {
      console.error('[receipts/revert] draft invoice not rebuilt:', invoiceError)
    }
  }

  return NextResponse.json({
    ok: true,
    receipt_id,
    previous_status: previousStatus,
    status: 'review',
    ledger_recomputed: ledger.ok,
    ledger_paid_cad: ledger.ok ? ledger.paidCad : null,
    ledger_error: ledger.ok ? null : ledger.error,
    invoice_rebuilt: invoiceRebuilt,
    ...(invoiceError ? { invoice_error: invoiceError } : {}),
    ...(ledger.ok
      ? {}
      : { warning: 'Receipt reopened, but the reimbursement ledger could not be recomputed. Tell Mirae before invoices are generated.' }),
    ...(invoiceRebuilt === false
      ? {
          warning:
            'Receipt reopened and the ledger is correct, but this month\'s draft invoice still ' +
            'shows the old amount. Batch approval will refuse it until it is regenerated: ' +
            `${invoiceError ?? 'reason not reported'}`
        }
      : {})
  })
}

type ReceiptRow = { bam_id: string; cohort_id: string; period: string }

/**
 * Recompute the month after a receipt has been pulled back out of it.
 *
 * This used to be its own forty lines of the same arithmetic that decide,
 * scheduler-audit and the auto-pass path each carried separately, and it did not
 * agree with them: it passed `monthsActiveThroughPeriod: 1` and `priorLedger: []`,
 * hardcoded, so it computed every reversal as though this were the BAM's first month
 * in the program.
 *
 * With rollover set to forfeit, which is every cohort (Robin 2026-08-04), that came
 * out to the same dollar figure, because carryover is always zero and the cumulative
 * cap never binds below one month's entitlement. It stored a different
 * `cap_snapshot_cad` than the other two writers, and the moment any cohort was
 * switched to accumulate it would have paid a different amount for "approve" than for
 * "approve, revert, approve again". A reimbursement that depends on which button was
 * pressed last is not a reimbursement anyone can audit.
 *
 * One function now. The behaviour that survived is the strictest of the three.
 */
async function recomputeLedger(
  admin: ReturnType<typeof serviceClient>,
  receipt: ReceiptRow
): Promise<{ ok: true; paidCad: number } | { ok: false; error: string }> {
  const out = await recomputeLedgerForPeriod(admin, {
    bamId: receipt.bam_id,
    cohortId: receipt.cohort_id,
    period: receipt.period
  })
  if (!out.ok) return { ok: false, error: out.error }
  return { ok: true, paidCad: out.paidCad }
}
