/**
 * POST /api/admin/receipts/decide  { receipt_id, decision: 'approved'|'rejected', reason: string }
 * Program admins' touchpoint 1 action. Reason required. Audit-logged automatically via DB trigger.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { computeMonthlyReimbursement } from '../../../../../lib/reimbursement'
import { DEFAULT_POLICY, softFloorFor } from '../../../../../lib/policy'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { receipt_id, decision, reason } = body
  if (!receipt_id || !['approved', 'rejected'].includes(decision) || !reason || reason.length < 3) {
    return NextResponse.json({ ok: false, message: 'receipt_id, decision, and reason (>=3 chars) required' }, { status: 400 })
  }

  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: user } = await supa.auth.getUser()
  const isDev = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
  if (!isDev) {
    if (!user.user) return NextResponse.json({ ok: false }, { status: 401 })
    const role = (user.user.user_metadata as { role?: string }).role
    if (!role || !['program_admin', 'super_admin'].includes(role)) {
      return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })
    }
  }

  const admin = serviceClient()
  const decidedBy = user.user?.id ?? '00000000-0000-0000-0000-000000000000'

  const { data: receipt } = await admin.from('receipts')
    .select('bam_id, cohort_id, period, bud_light_total_incl_tax, status')
    .eq('id', receipt_id).single()
  if (!receipt) return NextResponse.json({ ok: false, message: 'receipt not found' }, { status: 404 })
  if (!['pending', 'review', 'ocr_failed'].includes(receipt.status)) {
    return NextResponse.json({ ok: false, message: `receipt already decided (status: ${receipt.status})` }, { status: 409 })
  }

  const { error } = await admin.from('receipts').update({
    status: decision,
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
    decision_reason: reason
  }).eq('id', receipt_id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  let softFloorBreach = false

  if (decision === 'approved' && receipt.bud_light_total_incl_tax != null) {
    const { data: cohort } = await admin.from('cohorts')
      .select('reimbursement_max, rollover_mode, cap_multiplier').eq('id', receipt.cohort_id).single()

    const policy = {
      ...DEFAULT_POLICY,
      reimbursementMax: Number(cohort?.reimbursement_max ?? DEFAULT_POLICY.reimbursementMax),
      rolloverMode: (cohort?.rollover_mode ?? DEFAULT_POLICY.rolloverMode) as 'accumulate' | 'forfeit',
      capMultiplier: Number(cohort?.cap_multiplier ?? DEFAULT_POLICY.capMultiplier),
      firstCohortAllReview: false // classifier-only flag, not relevant to ledger math
    }

    // Sum ALL approved (+ auto_pass) receipts for this bam/period, not just this one —
    // the ledger reflects the whole month, and a BAM may submit multiple receipts.
    const { data: monthReceipts } = await admin.from('receipts')
      .select('bud_light_total_incl_tax, status')
      .eq('bam_id', receipt.bam_id).eq('period', receipt.period)
      .in('status', ['approved', 'auto_pass'])
    const receiptsTotal = (monthReceipts ?? []).reduce((s, r) => s + Number(r.bud_light_total_incl_tax ?? 0), 0)

    const { data: prior } = await admin.from('reimbursement_ledger')
      .select('*').eq('bam_id', receipt.bam_id).lt('period', receipt.period)
      .order('period', { ascending: true })
    const priorLedger = (prior ?? []).map(p => ({
      period: p.period,
      entitlementCad: Number(p.entitlement_cad),
      spentCad: Number(p.spent_cad),
      carryoverInCad: Number(p.carryover_in_cad),
      carryoverOutCad: Number(p.carryover_out_cad),
      paidCad: Number(p.paid_cad),
      spendableCapCad: Number(p.spendable_cap_cad),
      capSnapshotCad: Number(p.cap_snapshot_cad),
      shortfallFlag: p.shortfall_flag,
      policyVersion: p.policy_version
    }))
    const monthsActive = priorLedger.length + 1

    const out = computeMonthlyReimbursement({
      period: receipt.period,
      monthsActiveThroughPeriod: monthsActive,
      receiptsTotalInclHst: receiptsTotal,
      priorLedger,
      policy
    })
    // Soft-floor breach (for the warning email) is distinct from the ledger's
    // shortfallFlag (spent < full entitlement) — the warning only fires when
    // spend falls below entitlement - reviewBandPadding (e.g. $150 - $10 = $140).
    softFloorBreach = receiptsTotal < softFloorFor(policy)

    await admin.from('reimbursement_ledger').upsert({
      bam_id: receipt.bam_id,
      cohort_id: receipt.cohort_id,
      period: receipt.period,
      entitlement_cad: out.entitlement,
      spent_cad: receiptsTotal,
      carryover_in_cad: out.carryoverIn,
      carryover_out_cad: out.carryoverOut,
      paid_cad: out.paidThisMonth,
      spendable_cap_cad: out.spendableCap,
      cap_snapshot_cad: out.capSnapshot,
      shortfall_flag: out.shortfallFlag,
      policy_version: policy.policyVersion,
      created_by: 'system'
    }, { onConflict: 'bam_id,cohort_id,period' })
  }

  // Trigger shortfall warning if approved but below soft floor
  if (decision === 'approved' && softFloorBreach) {
    const baseUrl = req.nextUrl?.origin || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    fetch(`${baseUrl}/api/admin/receipts/shortfall-warning`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt_id })
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}
