/**
 * Q: What would "Can't be sent yet" list as MISSING today, and is each one a real gap?
 *
 * Same selection as app/api/admin/invoices/missing/route.ts, read-only. A row is real when
 * the student was already in the program during that month or has receipts in it. A row
 * whose student joined after the month ended is a false alarm: the panel used to list those
 * (Hannah Duxbury and Alivia Schulhauser, 2026-10-07, for September).
 *
 * The panel's own rule lives in lib/joined-after-month.ts, tested in tests/joined-after-month.test.ts.
 *
 * Usage: node scripts/probe/missing-invoice-panel.js
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

async function main() {
  const db = serviceClient()
  const { joinedAfterMonthEnded } = loadTs('lib/joined-after-month.ts')
  const now = new Date()
  const periods = [
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  ].map(d => d.toISOString().slice(0, 10))

  const [c, b, i, r] = await Promise.all([
    db.from('cohorts').select('id, start_date, end_date'),
    db.from('bams').select('id, first_name, last_name, status, created_at, cohort_id').in('status', ['active']).eq('is_test', false),
    db.from('invoices').select('bam_id, period').in('period', periods),
    db.from('receipts').select('bam_id, period').in('period', periods)
  ])
  for (const x of [c, b, i, r]) if (x.error) { fail(`unreadable: ${x.error.message}`); return verdict('missing invoice panel') }

  const cohorts = new Map(c.data.map(x => [x.id, x]))
  const has = new Set(i.data.map(x => `${x.bam_id}|${x.period}`))
  const rec = new Set(r.data.map(x => `${x.bam_id}|${x.period}`))
  let shown = 0
  for (const period of periods) {
    for (const bam of b.data) {
      const co = cohorts.get(bam.cohort_id)
      if (!co || period < String(co.start_date) || period > String(co.end_date)) continue
      const key = `${bam.id}|${period}`
      if (has.has(key)) continue
      const name = `${bam.first_name} ${bam.last_name} ${period.slice(0, 7)}`
      if (joinedAfterMonthEnded(bam.created_at, period) && !rec.has(key)) {
        info(`skipped: ${name} (joined ${String(bam.created_at).slice(0, 10)}, after the month, nothing owed)`)
        continue
      }
      shown++
      info(`panel lists: ${name} (joined ${String(bam.created_at).slice(0, 10)}, ${rec.has(key) ? 'has receipts' : 'no receipts'})`)
    }
  }
  if (shown === 0) pass('the panel lists no missing invoices')
  else info(`${shown} row(s) the panel lists as MISSING: each should be a student who was in the program that month`)
  verdict('missing invoice panel')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('missing invoice panel') })
