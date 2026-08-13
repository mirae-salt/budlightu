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
import { computeMonthlyReimbursement } from '../../../../../lib/reimbursement'
import { DEFAULT_POLICY } from '../../../../../lib/policy'
import { parseNonNegativeMoney } from '../../../../../lib/money'

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

async function recomputeLedger(
  admin: ReturnType<typeof serviceClient>,
  receipt: ReceiptRow
): Promise<{ ok: true; paidCad: number } | { ok: false; error: string }> {
  const { data: cohort, error: cohortErr } = await admin
    .from('cohorts')
    // No review_band_padding_cad here: that is a policy default, not a cohorts
    // column. Selecting it made this whole query error, so every revert failed
    // with "cohort read failed". Found by scripts/probe/schema-drift.js, which
    // exists because a column name inside a string literal is invisible to tsc.
    .select('reimbursement_max, rollover_mode, cap_multiplier, first_cohort_all_review')
    .eq('id', receipt.cohort_id)
    .maybeSingle()
  if (cohortErr) return { ok: false, error: `cohort read failed: ${cohortErr.message}` }
  if (!cohort) return { ok: false, error: 'cohort not found' }

  const reimbursementMax = parseNonNegativeMoney(cohort.reimbursement_max)
  if (reimbursementMax === null || reimbursementMax <= 0) {
    return { ok: false, error: 'cohort reimbursement_max is unusable' }
  }

  const { data: remaining, error: remErr } = await admin
    .from('receipts')
    .select('bud_light_total_incl_tax')
    .eq('bam_id', receipt.bam_id)
    .eq('cohort_id', receipt.cohort_id)
    .eq('period', receipt.period)
    .in('status', ['approved', 'auto_pass'])
  if (remErr) return { ok: false, error: `remaining receipts read failed: ${remErr.message}` }

  const total = (remaining ?? []).reduce((sum, r) => {
    const v = parseNonNegativeMoney(r.bud_light_total_incl_tax)
    return sum + (v ?? 0)
  }, 0)

  const out = computeMonthlyReimbursement({
    period: receipt.period,
    monthsActiveThroughPeriod: 1,
    receiptsTotalInclHst: total,
    priorLedger: [],
    policy: {
      ...DEFAULT_POLICY,
      reimbursementMax,
      rolloverMode: cohort.rollover_mode === 'accumulate' ? 'accumulate' : 'forfeit',
      capMultiplier: Number(cohort.cap_multiplier) || DEFAULT_POLICY.capMultiplier
    }
  })

  const { data: wrote, error: ledgerErr } = await admin
    .from('reimbursement_ledger')
    .upsert(
      {
        bam_id: receipt.bam_id,
        cohort_id: receipt.cohort_id,
        period: receipt.period,
        entitlement_cad: out.entitlement,
        spent_cad: total,
        carryover_in_cad: out.carryoverIn,
        carryover_out_cad: out.carryoverOut,
        paid_cad: out.paidThisMonth,
        spendable_cap_cad: out.spendableCap,
        cap_snapshot_cad: out.capSnapshot,
        shortfall_flag: out.shortfallFlag,
        policy_version: DEFAULT_POLICY.policyVersion
      },
      { onConflict: 'bam_id,cohort_id,period' }
    )
    .select('paid_cad')
  if (ledgerErr) return { ok: false, error: `ledger upsert failed: ${ledgerErr.message}` }
  if (!wrote || wrote.length !== 1) return { ok: false, error: 'ledger upsert affected no rows' }

  return { ok: true, paidCad: out.paidThisMonth }
}
