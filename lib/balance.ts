import { SupabaseClient } from '@supabase/supabase-js'

export const DEFAULT_REIMB_CAP = 150

export type BamBalance = {
  month: string
  cap: number
  used: number
  available: number
}

export async function getMonthlyBalance(
  db: SupabaseClient,
  bamId: string,
  now?: Date
): Promise<BamBalance> {
  const d = now ?? new Date()
  const year = d.getFullYear()
  const month = d.getMonth()
  const monthStart = new Date(year, month, 1).toISOString()
  const monthEnd = new Date(year, month + 1, 1).toISOString()
  const monthLabel = `${year}-${String(month + 1).padStart(2, '0')}`

  const { data: bam } = await db.from('bams')
    .select('cohort_id').eq('id', bamId).single()
  let cap = DEFAULT_REIMB_CAP
  if (bam?.cohort_id) {
    const { data: cohort } = await db.from('cohorts')
      .select('reimbursement_max').eq('id', bam.cohort_id).single()
    if (cohort?.reimbursement_max != null) cap = Number(cohort.reimbursement_max)
  }

  const { data } = await db.from('receipts')
    .select('bud_light_total_incl_tax')
    .eq('bam_id', bamId)
    .in('status', ['approved', 'auto_pass'])
    .gte('created_at', monthStart)
    .lt('created_at', monthEnd)

  const used = (data || []).reduce(
    (sum: number, r: { bud_light_total_incl_tax: number | null }) =>
      sum + (r.bud_light_total_incl_tax ?? 0),
    0
  )

  return {
    month: monthLabel,
    cap,
    used,
    available: Math.max(0, cap - used),
  }
}
