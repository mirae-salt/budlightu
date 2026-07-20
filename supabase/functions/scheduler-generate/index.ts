/**
 * Edge Function: scheduler-generate (cron: 16th of month at 08:00)
 *
 * For every active cohort:
 *   1. Advisory-lock the run
 *   2. For each active BAM: generate invoice payload → insert invoices row (status=draft)
 *      → render PDF (calls renderInvoicePdf; not yet implemented here)
 *      → queue three sends (AP, SharePoint, BAM copy) — all in draft/dryrun by default
 *   3. Robin approves batch in admin UI → flips to sent
 *
 * Nothing goes live in this scheduler run — that's the batch-approve step.
 */
import { serviceClient } from '../_shared/supabase-admin'
import { handler as genPayload } from '../generateInvoicePayload/index'

export async function handler(req: { period?: string } = {}) {
  const db = serviceClient()
  const period = req.period ?? firstOfCurrentMonth()

  const { data: locked } = await db.rpc('try_scheduler_lock', { job_name: `generate-${period}` })
  if (locked === false) return { ok: false, error: 'another generate run holds the lock — skipping' }

  const { data: cohorts } = await db.from('cohorts').select('*')
    .lte('start_date', period).gte('end_date', period)
  if (!cohorts?.length) return { ok: true, generated: 0 }

  let generated = 0
  const errors: string[] = []

  for (const cohort of cohorts) {
    const { data: bams } = await db.from('bams')
      .select('id').eq('cohort_id', cohort.id).eq('status', 'active')

    for (const bam of bams ?? []) {
      const res = await genPayload({ bam_id: bam.id, period })
      if (!res.ok || !res.payload) { errors.push(`${bam.id}: ${res.error}`); continue }

      const { error: insErr } = await db.from('invoices').insert({
        bam_id: bam.id,
        cohort_id: cohort.id,
        period,
        seq: res.seq!,
        invoice_number: res.invoice_number!,
        payload_json: res.payload,
        status: 'draft',
        currency: 'CAD'
      })
      if (insErr) { errors.push(`${bam.id}: ${insErr.message}`); continue }

      generated++
    }
  }

  return { ok: true, generated, errors }
}

function firstOfCurrentMonth(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-01`
}
