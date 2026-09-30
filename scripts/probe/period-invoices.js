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
    .select('id, first_name, last_name, status, cohort_id, is_test')
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

  // The dangerous direction. Since 2026-09-30 a pending student may hold a DRAFT on
  // purpose (/api/admin/invoices/missing), because batch-approve refuses a pending BAM and
  // an invoice with no address. So a draft is reported, and only one that has left draft,
  // or one on an archived student that was not voided, is a failure.
  const nonActiveWithInvoice = notActive.filter(b => byBam.has(b.id))
  const bad = nonActiveWithInvoice.filter(b => {
    const st = byBam.get(b.id).status
    return b.status === 'archived' ? st !== 'void' : st !== 'draft'
  })
  if (bad.length === 0) pass(`no BAM who is not active holds an invoice that has left draft`)
  for (const b of bad) {
    fail(`${b.first_name} ${b.last_name} is ${b.status} but ${byBam.get(b.id).invoice_number} is ${byBam.get(b.id).status}`)
  }
  for (const b of nonActiveWithInvoice.filter(x => !bad.includes(x))) {
    info(`${b.first_name} ${b.last_name} is ${b.status} with ${byBam.get(b.id).invoice_number}:${byBam.get(b.id).status} (held: cannot be sent while not active)`)
  }

  // The quiet direction. A student who is not active but has receipts on file this month
  // will never get an invoice: the 1st-of-month job only opens active BAMs and onboarding
  // opens one on completion. Lea Major sat in exactly this state in September 2026 with an
  // approved receipt, and the check above passed because she had no invoice to object to.
  const stuck = notActive.filter(b => !b.is_test && !byBam.has(b.id))
  if (stuck.length) {
    const { data: recs, error: rErr } = await db.from('receipts')
      .select('bam_id, status').eq('period', period).in('bam_id', stuck.map(b => b.id))
    if (rErr) fail(`receipts unreadable: ${rErr.message}`)
    else {
      const counts = new Map()
      for (const r of recs ?? []) counts.set(r.bam_id, (counts.get(r.bam_id) ?? 0) + 1)
      const owed = stuck.filter(b => counts.has(b.id))
      if (owed.length === 0) pass(`no ${stuck.length === 1 ? 'BAM' : 'BAMs'} still onboarding hold${stuck.length === 1 ? 's' : ''} a ${period} receipt`)
      else for (const b of owed) fail(`${b.first_name} ${b.last_name} is ${b.status} with ${counts.get(b.id)} receipt(s) for ${period} and no invoice: create the draft under "No invoice yet" on /admin/invoices`)
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
