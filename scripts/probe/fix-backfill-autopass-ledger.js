/**
 * Give every auto-passed receipt the ledger row it never got.
 *
 * Auto-passed receipts skipped both writers of reimbursement_ledger (an admin decision,
 * and the monthly sweep), so the money behind them was invisible: the dashboard read
 * $0 and no invoice could be drafted, because lib/draft-invoice refuses to invoice a
 * period whose ledger has not been computed. Fixed forward in app/api/receipts/ocr;
 * this repairs the rows that were created before that fix.
 *
 * It calls lib/recompute-ledger, the SAME function the OCR route now calls, so a clean
 * run here is also evidence that the fix does what it claims rather than a second
 * implementation that happens to agree.
 *
 * Dry run by default. Pass --apply to write.
 *   node scripts/probe/fix-backfill-autopass-ledger.js
 *   node scripts/probe/fix-backfill-autopass-ledger.js --apply
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const APPLY = process.argv.includes('--apply')

async function main() {
  const db = serviceClient()
  const { recomputeLedgerForPeriod } = loadTs('lib/recompute-ledger.ts')

  const { data: receipts, error: rErr } = await db.from('receipts')
    .select('id, bam_id, cohort_id, period, status, bud_light_total_incl_tax')
    .in('status', ['approved', 'auto_pass'])
  if (rErr) {
    fail(`receipts unreadable: ${rErr.message}`)
    return verdict('backfill auto-pass ledger')
  }

  const { data: ledger, error: lErr } = await db.from('reimbursement_ledger')
    .select('bam_id, cohort_id, period, paid_cad')
  if (lErr) {
    fail(`ledger unreadable: ${lErr.message}`)
    return verdict('backfill auto-pass ledger')
  }

  const { data: invoices, error: iErr } = await db.from('invoices')
    .select('bam_id, cohort_id, period, invoice_number, status')
  if (iErr) {
    fail(`invoices unreadable: ${iErr.message}`)
    return verdict('backfill auto-pass ledger')
  }

  const key = r => `${r.bam_id}|${r.cohort_id}|${r.period}`
  const haveLedger = new Set(ledger.map(key))
  const haveInvoice = new Set(invoices.map(key))

  // Every period that has settled money, whether or not it has a ledger row. The two
  // repairs are separate: a period can have the ledger and still be missing the
  // invoice, which is exactly the state the first half of this fix leaves behind.
  const periods = new Map()
  for (const r of receipts) {
    periods.set(key(r), { bamId: r.bam_id, cohortId: r.cohort_id, period: r.period })
  }

  const missing = new Map()
  for (const [k, p] of periods) {
    if (!haveLedger.has(k) || !haveInvoice.has(k)) missing.set(k, p)
  }

  if (missing.size === 0) {
    pass('every settled period already has both a ledger row and an invoice - nothing to backfill')
    return verdict('backfill auto-pass ledger')
  }

  info(`${missing.size} period(s) with settled receipts and a missing ledger row or invoice`)

  for (const [, m] of missing) {
    // Names, so the output is checkable against the admin screen rather than uuids.
    const { data: bam } = await db.from('bams')
      .select('first_name, last_name').eq('id', m.bamId).maybeSingle()
    const who = bam ? `${bam.first_name} ${bam.last_name}` : m.bamId.slice(0, 8)

    if (!APPLY) {
      info(`WOULD WRITE  ${who} ${m.period}`)
      continue
    }

    const out = await recomputeLedgerForPeriod(db, m)
    if (!out.ok) {
      fail(`${who} ${m.period}: ${out.error}`)
      continue
    }

    // Read back through a separate query, not through the function's own return value.
    const { data: check, error: checkErr } = await db.from('reimbursement_ledger')
      .select('paid_cad, spent_cad')
      .eq('bam_id', m.bamId).eq('cohort_id', m.cohortId).eq('period', m.period)
    if (checkErr || (check ?? []).length !== 1) {
      fail(`${who} ${m.period}: wrote, but the row could not be read back (${checkErr?.message ?? `rows=${(check ?? []).length}`})`)
      continue
    }
    const stored = Number(check[0].paid_cad)
    if (Math.abs(stored - out.paidCad) > 0.005) {
      fail(`${who} ${m.period}: function said $${out.paidCad.toFixed(2)}, table holds $${stored.toFixed(2)}`)
      continue
    }
    pass(`${who} ${m.period}: spent $${out.spentCad.toFixed(2)} -> pays $${stored.toFixed(2)}${out.shortfall ? ` (under the $${out.shortfallWarnBelowCad} floor)` : ''}`)

    // The ledger row is what was blocking the draft, so ask for the draft too. Same
    // call and same order as the OCR route, which is the point: if this succeeds here
    // it succeeds there.
    const { upsertDraftInvoice } = loadTs('lib/draft-invoice.ts')
    const inv = await upsertDraftInvoice(db, m.bamId, m.cohortId, m.period)
    if (inv.ok) {
      pass(`${who} ${m.period}: invoice ${inv.invoiceNumber} ${inv.created ? 'created' : 'updated'} at $${inv.reimbursementCad.toFixed(2)} reimbursement`)
    } else {
      fail(`${who} ${m.period}: ledger is fine but no invoice - ${inv.reason}`)
    }
  }

  if (!APPLY) info('dry run. Re-run with --apply to write.')
  verdict('backfill auto-pass ledger')
}
main()
