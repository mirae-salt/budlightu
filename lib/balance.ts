import { SupabaseClient } from '@supabase/supabase-js'
import { round2, parseNonNegativeMoney } from './money'

export const DEFAULT_REIMB_CAP = 150

export type BamBalance = {
  /** "YYYY-MM" label for display */
  month: string
  /** "YYYY-MM-01" — the receipts.period value this balance was computed for */
  period: string
  cap: number
  used: number
  available: number
  /**
   * false = the balance could NOT be determined (query error / bad period).
   * Callers that use this for a fraud gate MUST fail closed (force review)
   * rather than treating `available` as trustworthy.
   */
  ok: boolean
  error?: string
}

/** Normalize "2026-08", "2026-08-14", a Date, or undefined → "YYYY-MM-01". */
export function normalizePeriod(period?: string | Date | null, now?: Date): string | null {
  if (period instanceof Date) {
    if (isNaN(period.getTime())) return null
    return `${period.getUTCFullYear()}-${String(period.getUTCMonth() + 1).padStart(2, '0')}-01`
  }
  if (typeof period === 'string' && period.trim()) {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(period.trim())
    if (!m) return null
    const mm = Number(m[2])
    if (mm < 1 || mm > 12) return null
    return `${m[1]}-${m[2]}-01`
  }
  const d = now ?? new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/**
 * Monthly reimbursement balance for one BAM.
 *
 * P1-5 (audit 2026-08-07): this used to filter on `receipts.created_at`, a column
 *   that does not exist (the real one is `uploaded_at`). PostgREST returned 42703,
 *   only `data` was destructured, so `used` was always 0 and `available` was
 *   always the full cap — silently disabling the `over_balance` fraud gate and
 *   making `near_balance_pattern` compare against a constant.
 *
 * P1-23: the window is now the receipts `period` (the month the spend is claimed
 *   FOR), matching every other path. Filtering by upload timestamp meant a July
 *   receipt uploaded on Aug 1 ate the student's August cap.
 */
export async function getMonthlyBalance(
  db: SupabaseClient,
  bamId: string,
  period?: string | Date | null,
  now?: Date
): Promise<BamBalance> {
  const p = normalizePeriod(period, now)
  if (!p) {
    return {
      month: '', period: '', cap: DEFAULT_REIMB_CAP, used: 0, available: 0,
      ok: false, error: `unrecognized period: ${String(period)}`
    }
  }
  const monthLabel = p.slice(0, 7)

  const { data: bam, error: bamErr } = await db.from('bams')
    .select('cohort_id').eq('id', bamId).maybeSingle()
  if (bamErr) {
    return { month: monthLabel, period: p, cap: DEFAULT_REIMB_CAP, used: 0, available: 0, ok: false, error: `bams lookup failed: ${bamErr.message}` }
  }
  if (!bam) {
    return { month: monthLabel, period: p, cap: DEFAULT_REIMB_CAP, used: 0, available: 0, ok: false, error: `bam ${bamId} not found` }
  }

  let cap = DEFAULT_REIMB_CAP
  if (bam.cohort_id) {
    const { data: cohort, error: cohortErr } = await db.from('cohorts')
      .select('reimbursement_max').eq('id', bam.cohort_id).maybeSingle()
    if (cohortErr) {
      return { month: monthLabel, period: p, cap, used: 0, available: 0, ok: false, error: `cohorts lookup failed: ${cohortErr.message}` }
    }
    const parsed = parseNonNegativeMoney(cohort?.reimbursement_max)
    if (parsed !== null) cap = parsed
  }

  const { data, error } = await db.from('receipts')
    .select('bud_light_total_incl_tax')
    .eq('bam_id', bamId)
    .eq('period', p)
    .in('status', ['approved', 'auto_pass'])

  if (error) {
    // Fail closed: report ok:false so fraud gates do not silently see a full cap.
    return { month: monthLabel, period: p, cap, used: 0, available: 0, ok: false, error: `receipts query failed: ${error.message}` }
  }

  let used = 0
  for (const r of data ?? []) {
    const v = parseNonNegativeMoney((r as { bud_light_total_incl_tax: unknown }).bud_light_total_incl_tax)
    if (v !== null) used = round2(used + v)
  }

  return {
    month: monthLabel,
    period: p,
    cap,
    used,
    available: round2(Math.max(0, cap - used)),
    ok: true
  }
}
