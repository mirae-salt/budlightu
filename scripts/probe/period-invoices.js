/**
 * Q: Does every active BAM have this month's invoice, and does nobody else?
 *
 * Janet, 2026-09-04, asked to be able to put a bar tab on a student's invoice before
 * that student submits anything. That needs the invoice to exist, which needs a ledger
 * row, which used to need a receipt. Now a $0 ledger row is written on the 1st and on
 * onboarding, and the invoice follows.
 *
 * The two things worth checking are opposites of each other. An active BAM without an
 * invoice cannot be given a line. A BAM WITHOUT banking who somehow has one is worse: no
 * code re-checks banking at send time, so a blank direct-deposit block could reach AP.
 *
 * Read only. Usage: node scripts/probe/period-invoices.js [YYYY-MM-01]
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

function thisPeriod() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

async function main() {
  const db = serviceClient()
  const period = process.argv[2] || thisPeriod()
  info(`period ${period}`)

  const { data: cohorts, error: cErr } = await db.from('cohorts').select('id, name, start_date, end_date')
  if (cErr) { fail(`cohorts unreadable: ${cErr.message}`); return verdict('period invoices') }
  const inWindow = (cohorts ?? []).filter(c => period >= String(c.start_date) && period <= String(c.end_date))
  if (!inWindow.length) { info('no cohort runs this month, so no invoices are due'); return verdict('period invoices') }

  const { data: bams, error: bErr } = await db.from('bams')
    .select('id, first_name, last_name, status, cohort_id')
    .in('cohort_id', inWindow.map(c => c.id))
  if (bErr) { fail(`bams unreadable: ${bErr.message}`); return verdict('period invoices') }

  const { data: invoices, error: iErr } = await db.from('invoices')
    .select('bam_id, invoice_number, status, payload_json').eq('period', period)
  if (iErr) { fail(`invoices unreadable: ${iErr.message}`); return verdict('period invoices') }
  const byBam = new Map((invoices ?? []).map(i => [i.bam_id, i]))

  const active = (bams ?? []).filter(b => b.status === 'active')
  const notActive = (bams ?? []).filter(b => b.status !== 'active')

  const missing = active.filter(b => !byBam.has(b.id))
  if (missing.length === 0) pass(`all ${active.length} active BAMs have a ${period} invoice`)
  else for (const b of missing) fail(`${b.first_name} ${b.last_name} is active with no invoice, so no line can be added to them`)

  // The dangerous direction.
  const shouldNotHave = notActive.filter(b => byBam.has(b.id))
  if (shouldNotHave.length === 0) {
    pass(`none of the ${notActive.length} BAMs still onboarding has one`)
  } else {
    for (const b of shouldNotHave) {
      fail(`${b.first_name} ${b.last_name} is ${b.status} but has ${byBam.get(b.id).invoice_number}: it may carry no banking, and nothing re-checks that at send time`)
    }
  }

  // A seeded invoice is salary only. Anything else on it was put there by a person or a
  // receipt, which is what it is for; this just reports the shape.
  const seeded = (invoices ?? []).filter(i => (i.payload_json?.lines ?? []).length === 1)
  const withMore = (invoices ?? []).length - seeded.length
  info(`${seeded.length} invoice(s) hold only the salary line, ${withMore} carry a reimbursement or an added line`)

  const notDraft = (invoices ?? []).filter(i => i.status !== 'draft')
  if (notDraft.length) info(`${notDraft.length} have left draft: ${notDraft.map(i => `${i.invoice_number}:${i.status}`).join(', ')}`)

  verdict('period invoices')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('period invoices') })
