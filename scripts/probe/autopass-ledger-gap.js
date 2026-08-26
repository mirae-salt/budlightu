/**
 * Q: Does an auto-passed receipt leave the money invisible?
 *
 * The dashboard's spend figure and the draft-invoice amount both come from
 * reimbursement_ledger.paid_cad. Only /api/admin/receipts/decide writes that row.
 * A receipt the classifier auto-passes never goes through decide, so this asks the
 * database whether there are auto_pass receipts with no ledger row behind them.
 *
 * Read only. Usage: node scripts/probe/autopass-ledger-gap.js
 */
const { serviceClient, pass, fail, verdict } = require('./_lib')

async function main() {
  const db = serviceClient()

  const { data: cohorts, error: cErr } = await db.from('cohorts')
    .select('id, name, first_cohort_all_review, reimbursement_max, po_number, salary_default')
  if (cErr) return fail(`cohorts unreadable: ${cErr.message}`), verdict('autopass ledger gap')
  for (const c of cohorts) {
    pass(`cohort ${String(c.name).padEnd(14)} all_review=${c.first_cohort_all_review} max=${c.reimbursement_max} po=${c.po_number} salary=${c.salary_default}`)
  }

  const { data: receipts, error: rErr } = await db.from('receipts')
    .select('id, bam_id, cohort_id, period, status, bud_light_total_incl_tax')
  if (rErr) return fail(`receipts unreadable: ${rErr.message}`), verdict('autopass ledger gap')

  const byStatus = {}
  for (const r of receipts) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  pass(`receipt statuses: ${JSON.stringify(byStatus)}`)

  const { data: ledger, error: lErr } = await db.from('reimbursement_ledger')
    .select('bam_id, cohort_id, period, paid_cad, spent_cad')
  if (lErr) return fail(`ledger unreadable: ${lErr.message}`), verdict('autopass ledger gap')
  pass(`reimbursement_ledger has ${ledger.length} rows`)

  const key = r => `${r.bam_id}|${r.cohort_id}|${r.period}`
  const haveLedger = new Set(ledger.map(key))

  const moneyStates = ['approved', 'auto_pass']
  const gaps = new Map()
  for (const r of receipts) {
    if (!moneyStates.includes(r.status)) continue
    if (haveLedger.has(key(r))) continue
    const k = key(r)
    const g = gaps.get(k) ?? { period: r.period, bam_id: r.bam_id, n: 0, sum: 0, statuses: new Set() }
    g.n += 1
    g.sum += Number(r.bud_light_total_incl_tax ?? 0)
    g.statuses.add(r.status)
    gaps.set(k, g)
  }

  if (gaps.size === 0) {
    pass('every approved/auto_pass receipt has a ledger row')
  } else {
    for (const [, g] of gaps) {
      fail(`no ledger row: bam ${g.bam_id.slice(0, 8)} ${g.period} - ${g.n} receipt(s) [${[...g.statuses].join(',')}] worth $${g.sum.toFixed(2)} invisible to the dashboard`)
    }
  }

  const { data: invoices, error: iErr } = await db.from('invoices')
    .select('bam_id, period, status, invoice_number')
  if (iErr) fail(`invoices unreadable: ${iErr.message}`)
  else pass(`invoices: ${invoices.length} rows (${invoices.map(i => `${i.invoice_number}:${i.status}`).join(', ') || 'none'})`)

  verdict('autopass ledger gap')
}
main()
