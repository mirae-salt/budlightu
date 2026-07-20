/**
 * Edge Function: scheduler-audit (cron: 15th of month at 23:00)
 *
 * For every active cohort:
 *   1. Advisory-lock the run (P0-5a: prevent double-fire)
 *   2. For each BAM in the cohort with receipts in this period:
 *      - Sum bud_light_total_incl_tax of APPROVED (+ auto_pass) receipts, EXCLUDING ocr_failed
 *      - Compute reimbursement via lib/reimbursement.ts (uses prior ledger for carryover)
 *      - Upsert reimbursement_ledger row
 *   3. Build shortfall list, email Robin.
 */
import { serviceClient } from '../_shared/supabase-admin'
import { computeMonthlyReimbursement } from '../../../lib/reimbursement'
import { DEFAULT_POLICY } from '../../../lib/policy'

export async function handler(req: { period?: string } = {}) {
  const db = serviceClient()
  const period = req.period ?? firstOfCurrentMonth()

  // ── advisory lock ──
  const { data: locked } = await db.rpc('try_scheduler_lock', { job_name: `audit-${period}` })
  if (locked === false) return { ok: false, error: 'another audit run holds the lock — skipping' }

  const { data: cohorts } = await db.from('cohorts').select('*').lte('start_date', period).gte('end_date', period)
  if (!cohorts?.length) return { ok: true, cohorts: 0 }

  let processed = 0
  const shortfall: Array<{ bamId: string; name: string; spent: number; entitlement: number }> = []

  for (const cohort of cohorts) {
    const { data: bams } = await db.from('bams')
      .select('id, first_name, last_name, cohort_id')
      .eq('cohort_id', cohort.id).eq('status', 'active')
    if (!bams?.length) continue

    for (const bam of bams) {
      // approved receipts (exclude ocr_failed per P0-5c)
      const { data: rcpts } = await db.from('receipts')
        .select('bud_light_total_incl_tax, status')
        .eq('bam_id', bam.id).eq('period', period)
        .in('status', ['approved', 'auto_pass'])

      const receiptsTotal = (rcpts ?? []).reduce((s, r) => s + Number(r.bud_light_total_incl_tax ?? 0), 0)

      // prior ledger for carryover
      const { data: prior } = await db.from('reimbursement_ledger')
        .select('*').eq('bam_id', bam.id).lt('period', period)
        .order('period', { ascending: true })

      const priorLedger = (prior ?? []).map(p => ({
        period: p.period,
        entitlementUsd: Number(p.entitlement_usd),
        spentUsd: Number(p.spent_usd),
        carryoverInUsd: Number(p.carryover_in_usd),
        carryoverOutUsd: Number(p.carryover_out_usd),
        paidUsd: Number(p.paid_usd),
        spendableCapUsd: Number(p.spendable_cap_usd),
        capSnapshotUsd: Number(p.cap_snapshot_usd),
        shortfallFlag: p.shortfall_flag,
        policyVersion: p.policy_version
      }))

      const monthsActive = priorLedger.length + 1

      const policy = { ...DEFAULT_POLICY,
        rolloverMode: cohort.rollover_mode as 'accumulate' | 'forfeit',
        reimbursementMax: Number(cohort.reimbursement_max),
        capMultiplier: Number(cohort.cap_multiplier),
        firstCohortAllReview: false,   // relevant to classifier, not ledger
        policyVersion: 1
      }

      const out = computeMonthlyReimbursement({
        period,
        monthsActiveThroughPeriod: monthsActive,
        receiptsTotalInclHst: receiptsTotal,
        priorLedger,
        policy
      })

      await db.from('reimbursement_ledger').upsert({
        bam_id: bam.id, cohort_id: cohort.id, period,
        entitlement_usd:      out.entitlement,
        spent_usd:            receiptsTotal,
        carryover_in_usd:     out.carryoverIn,
        carryover_out_usd:    out.carryoverOut,
        paid_usd:             out.paidThisMonth,
        spendable_cap_usd:    out.spendableCap,
        cap_snapshot_usd:     out.capSnapshot,
        shortfall_flag:       out.shortfallFlag,
        policy_version:       policy.policyVersion,
        created_by:           'system'
      }, { onConflict: 'bam_id,cohort_id,period' })

      if (out.shortfallFlag) {
        shortfall.push({
          bamId: bam.id,
          name: `${bam.first_name} ${bam.last_name}`,
          spent: receiptsTotal,
          entitlement: out.entitlement
        })
      }
      processed++
    }
  }

  return { ok: true, processed, shortfall_count: shortfall.length, shortfall }
}

function firstOfCurrentMonth(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-01`
}
