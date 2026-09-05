/**
 * Day-one job: every active BAM gets that month's draft invoice.
 *
 * Janet, 2026-09-04, asked to be able to put a bar tab or an Uber on a student's invoice
 * before that student has submitted anything. Until now the only invoices that existed
 * were the ones a receipt had created, so most of the roster had nothing to edit.
 *
 * Shaped like the other two schedulers: it reports per-BAM errors rather than throwing,
 * so one bad row cannot stop the other fifty-seven, and the cron log says which.
 */
import { serviceClient } from '../supabase/functions/_shared/supabase-admin'
import { seedPeriodInvoice, periodOf } from './seed-period-invoice'

export type SeedRunResult = {
  ok: boolean
  period: string
  seeded: number
  alreadyThere: number
  skipped: Array<{ bam: string; reason: string }>
}

export async function runSeedInvoices(
  input: { period?: string; db?: ReturnType<typeof serviceClient> } = {}
): Promise<SeedRunResult> {
  // Injectable so this can be run from a probe or a test without a live Edge runtime.
  const db = input.db ?? serviceClient()
  // Day one, so the month being opened is this one unless a caller names another.
  const period = input.period ?? periodOf(new Date())
  const skipped: SeedRunResult['skipped'] = []
  let seeded = 0
  let alreadyThere = 0

  const { data: cohorts, error: cErr } = await db.from('cohorts')
    .select('id, name, start_date, end_date')
  if (cErr) return { ok: false, period, seeded, alreadyThere, skipped: [{ bam: '(all)', reason: `cohorts unreadable: ${cErr.message}` }] }

  for (const cohort of cohorts ?? []) {
    // Outside the cohort's own months there is no salary to invoice, so seeding one
    // would create a document for a month the program does not run.
    if (period < String(cohort.start_date) || period > String(cohort.end_date)) continue

    const { data: bams, error: bErr } = await db.from('bams')
      .select('id, first_name, last_name')
      .eq('cohort_id', cohort.id)
      .eq('status', 'active')
    if (bErr) {
      skipped.push({ bam: `(cohort ${cohort.name})`, reason: `bams unreadable: ${bErr.message}` })
      continue
    }

    for (const bam of bams ?? []) {
      const out = await seedPeriodInvoice(db, { bamId: bam.id, cohortId: cohort.id, period })
      const who = `${bam.first_name} ${bam.last_name}`
      if (!out.ok) {
        /*
         * Expected for anyone mid-onboarding: generateInvoicePayload refuses to build an
         * invoice with no banking or no address (P0-E), and nothing re-checks that at
         * send time, so a blank one must never exist. Reported, not retried.
         */
        skipped.push({ bam: who, reason: out.reason })
        continue
      }
      if (out.created) seeded++
      else alreadyThere++
    }
  }

  return { ok: true, period, seeded, alreadyThere, skipped }
}
