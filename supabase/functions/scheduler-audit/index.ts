/**
 * Edge Function: scheduler-audit (cron: 15th of month at 23:00)
 *
 * For every active cohort:
 *   1. Take a REAL lock on the run (P1-3)
 *   2. Sweep receipts stranded at status='pending' so they become visible (P1-13)
 *   3. For each BAM in the cohort with receipts in this period:
 *      - Sum bud_light_total_incl_tax of APPROVED (+ auto_pass) receipts, EXCLUDING ocr_failed
 *      - Compute reimbursement via lib/reimbursement.ts
 *      - Upsert reimbursement_ledger row, error-checked and read back (P0-H)
 *   4. Return the shortfall list and every error encountered.
 *
 * Audit fixes applied here (AUDIT-2026-08-07):
 *   P1-3  `try_scheduler_lock` used pg_try_advisory_xact_lock, which is TRANSACTION
 *         scoped; each PostgREST RPC commits immediately, so the lock was released
 *         before any work started and two concurrent runs both proceeded. The caller
 *         also ignored the RPC error and compared `null === false`, so an errored RPC
 *         failed OPEN. Now: acquire_scheduler_lock (a lock ROW with a TTL), an RPC
 *         error is treated as "did not acquire", and the lock is released at the end.
 *   P0-H  every supabase error is checked. The ledger upsert in particular is the write
 *         that determines what a BAM is paid; it is read back and any failure is
 *         reported instead of the function returning ok:true.
 *   P0-H  a cohort whose reimbursement_max / cap_multiplier is unreadable is SKIPPED,
 *         never silently paid at the DEFAULT_POLICY $150.
 */
import { serviceClient } from '../_shared/supabase-admin'
import { computeMonthlyReimbursement } from '../../../lib/reimbursement'
import { DEFAULT_POLICY } from '../../../lib/policy'

const LOCK_TTL_SECONDS = 900

type AuditError = { scope: string; id?: string; message: string }

export async function handler(req: { period?: string } = {}) {
  const db = serviceClient()
  const period = req.period ?? firstOfCurrentMonth()
  const jobName = `audit-${period}`
  const errors: AuditError[] = []

  // ── real lock ──────────────────────────────────────────────────────────────
  const { data: locked, error: lockErr } = await db.rpc('acquire_scheduler_lock', {
    p_job_name: jobName,
    p_ttl_seconds: LOCK_TTL_SECONDS,
    p_holder: `scheduler-audit@${new Date().toISOString()}`
  })
  if (lockErr) {
    // Fail CLOSED: an unknown lock state means we do not know whether another run
    // is live, and running the ledger twice concurrently is a money bug.
    return { ok: false, error: `could not acquire the audit lock: ${lockErr.message}` }
  }
  if (locked !== true) {
    return { ok: false, error: 'another audit run holds the lock, skipping' }
  }

  try {
    return await runAudit(db, period, errors)
  } finally {
    const { error: relErr } = await db.rpc('release_scheduler_lock', { p_job_name: jobName })
    if (relErr) {
      console.error('[scheduler-audit] could not release lock', jobName, relErr.message,
        `- it expires automatically in ${LOCK_TTL_SECONDS}s`)
    }
  }
}

async function runAudit(
  db: ReturnType<typeof serviceClient>,
  period: string,
  errors: AuditError[]
) {
  // ── P1-13 sweep: nothing may stay invisible at status='pending' ────────────
  // Receipts whose OCR trigger was dropped become 'ocr_failed', which IS shown in
  // the admin review queue. ocr_failed is excluded from shortfall math, so this
  // cannot invent a shortfall for the BAM.
  let strandedReceipts: Array<{ receipt_id: string; out_bam_id: string; out_period: string }> = []
  const { data: swept, error: sweepErr } = await db.rpc('sweep_stale_ocr_receipts', { p_stale_minutes: 15 })
  if (sweepErr) {
    errors.push({ scope: 'sweep_stale_ocr_receipts', message: sweepErr.message })
  } else if (Array.isArray(swept)) {
    strandedReceipts = swept as typeof strandedReceipts
  }

  const { data: cohorts, error: cohortsErr } = await db.from('cohorts')
    .select('*').lte('start_date', period).gte('end_date', period)
  if (cohortsErr) {
    return { ok: false, error: `cohorts query failed: ${cohortsErr.message}`, errors }
  }
  if (!cohorts?.length) {
    return { ok: errors.length === 0, cohorts: 0, errors, stranded_receipts: strandedReceipts }
  }

  let processed = 0
  const shortfall: Array<{ bamId: string; name: string; spent: number; entitlement: number }> = []

  for (const cohort of cohorts) {
    // P0-H: never fall back to DEFAULT_POLICY for a cohort whose own numbers are
    // unreadable — that pays $150 for a cohort configured at a different cap.
    const cohortMax = Number(cohort.reimbursement_max)
    const cohortMultiplier = Number(cohort.cap_multiplier)
    const rolloverMode = cohort.rollover_mode
    if (!Number.isFinite(cohortMax) || cohortMax <= 0) {
      errors.push({ scope: 'cohort', id: cohort.id, message: `reimbursement_max is not usable ("${String(cohort.reimbursement_max)}"), cohort skipped` })
      continue
    }
    if (!Number.isFinite(cohortMultiplier) || cohortMultiplier <= 0) {
      errors.push({ scope: 'cohort', id: cohort.id, message: `cap_multiplier is not usable ("${String(cohort.cap_multiplier)}"), cohort skipped` })
      continue
    }
    if (rolloverMode !== 'forfeit' && rolloverMode !== 'accumulate') {
      errors.push({ scope: 'cohort', id: cohort.id, message: `rollover_mode is not usable ("${String(rolloverMode)}"), cohort skipped` })
      continue
    }

    const policy = {
      ...DEFAULT_POLICY,
      rolloverMode: rolloverMode as 'accumulate' | 'forfeit',
      reimbursementMax: cohortMax,
      capMultiplier: cohortMultiplier,
      firstCohortAllReview: false,   // relevant to the classifier, not the ledger
      policyVersion: 1
    }

    const { data: bams, error: bamsErr } = await db.from('bams')
      .select('id, first_name, last_name, cohort_id')
      .eq('cohort_id', cohort.id).eq('status', 'active')
    if (bamsErr) {
      errors.push({ scope: 'bams', id: cohort.id, message: bamsErr.message })
      continue
    }
    if (!bams?.length) continue

    for (const bam of bams) {
      // approved receipts (exclude ocr_failed per P0-5c)
      const { data: rcpts, error: rcptErr } = await db.from('receipts')
        .select('bud_light_total_incl_tax, status')
        .eq('bam_id', bam.id).eq('period', period)
        .in('status', ['approved', 'auto_pass'])
      if (rcptErr) {
        errors.push({ scope: 'receipts', id: bam.id, message: rcptErr.message })
        continue
      }

      let receiptsTotal = 0
      for (const r of rcpts ?? []) {
        const v = Number(r.bud_light_total_incl_tax ?? 0)
        if (Number.isFinite(v) && v > 0) receiptsTotal = Math.round((receiptsTotal + v) * 100) / 100
      }

      // prior ledger for carryover
      const { data: prior, error: priorErr } = await db.from('reimbursement_ledger')
        .select('*').eq('bam_id', bam.id).lt('period', period)
        .order('period', { ascending: true })
      if (priorErr) {
        errors.push({ scope: 'reimbursement_ledger.read', id: bam.id, message: priorErr.message })
        continue
      }

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

      let out
      try {
        out = computeMonthlyReimbursement({
          period,
          monthsActiveThroughPeriod: monthsActive,
          receiptsTotalInclHst: receiptsTotal,
          priorLedger,
          policy
        })
      } catch (e) {
        errors.push({ scope: 'computeMonthlyReimbursement', id: bam.id, message: e instanceof Error ? e.message : String(e) })
        continue
      }

      // P0-H: this write decides what the BAM is paid. Checked and read back.
      const { data: ledgerRows, error: ledgerErr } = await db.from('reimbursement_ledger').upsert({
        bam_id: bam.id, cohort_id: cohort.id, period,
        entitlement_cad:      out.entitlement,
        spent_cad:            receiptsTotal,
        carryover_in_cad:     out.carryoverIn,
        carryover_out_cad:    out.carryoverOut,
        paid_cad:             out.paidThisMonth,
        spendable_cap_cad:    out.spendableCap,
        cap_snapshot_cad:     out.capSnapshot,
        shortfall_flag:       out.shortfallFlag,
        policy_version:       policy.policyVersion,
        created_by:           'system'
      }, { onConflict: 'bam_id,cohort_id,period' })
        .select('id, paid_cad')

      if (ledgerErr) {
        errors.push({ scope: 'reimbursement_ledger.upsert', id: bam.id, message: ledgerErr.message })
        continue
      }
      if (!ledgerRows || ledgerRows.length !== 1) {
        errors.push({ scope: 'reimbursement_ledger.upsert', id: bam.id, message: `affected ${ledgerRows?.length ?? 0} rows, expected 1` })
        continue
      }
      const persistedPaid = Number(ledgerRows[0].paid_cad)
      if (!Number.isFinite(persistedPaid) || Math.abs(persistedPaid - out.paidThisMonth) > 0.005) {
        errors.push({
          scope: 'reimbursement_ledger.readback',
          id: bam.id,
          message: `stored paid_cad=${String(ledgerRows[0].paid_cad)} but computed ${out.paidThisMonth}`
        })
        continue
      }

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

  return {
    // ok reflects what actually happened; a partial run is not a success.
    ok: errors.length === 0,
    period,
    processed,
    shortfall_count: shortfall.length,
    shortfall,
    stranded_receipts: strandedReceipts,
    errors
  }
}

function firstOfCurrentMonth(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-01`
}
