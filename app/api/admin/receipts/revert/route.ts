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
  if (!reason || String(reason).trim().length < 3) {
    return NextResponse.json(
      { ok: false, message: 'A reason is required so the audit trail explains why this was reopened.' },
      { status: 400 }
    )
  }

  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const admin = serviceClient()

  const { data: receipt, error: readErr } = await admin
    .from('receipts')
    .select('id, bam_id, cohort_id, period, status, bud_light_total_incl_tax, reverted_count')
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
    await admin.from('receipts')
      .update({ status: previousStatus, reverted_count: receipt.reverted_count ?? 0, reverted_at: null, reverted_by: null })
      .eq('id', receipt_id)
    return NextResponse.json(
      { ok: false, error: `revert rolled back: audit log write failed (${auditErr.message})` },
      { status: 500 }
    )
  }

  // Recompute the ledger from what is still approved for this BAM/period.
  const ledger = await recomputeLedger(admin, receipt)

  return NextResponse.json({
    ok: true,
    receipt_id,
    previous_status: previousStatus,
    status: 'review',
    ledger_recomputed: ledger.ok,
    ledger_paid_cad: ledger.ok ? ledger.paidCad : null,
    ledger_error: ledger.ok ? null : ledger.error,
    ...(ledger.ok
      ? {}
      : { warning: 'Receipt reopened, but the reimbursement ledger could not be recomputed. Tell Mirae before invoices are generated.' })
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
