/**
 * Reprocesses receipts whose stored amount predates the bottle-deposit fix.
 *
 * The classifier was corrected on 2026-09-04 (see lib/classify-receipt.ts): a bottle
 * deposit is not taxed, and folding it into the taxable Bud Light sum made the tax
 * calculation fail and fall back to the pre-tax figure. Seven receipts were short, from
 * $1.50 to $12.88.
 *
 * The ledger sums the amount SAVED on each receipt and never re-runs the classifier, so
 * fixing the code fixed nothing that already existed. This is the deliberate pass over
 * the rows.
 *
 * WHAT IT WILL NOT DO
 *
 *   It refuses to touch a receipt whose invoice has left draft. Once an invoice is
 *   approved, sent or paid, the amount on it is a document AP holds, and changing the
 *   number behind it silently is not a correction, it is a discrepancy.
 *
 *   It never changes a receipt's status. An approved receipt stays approved; only the
 *   amount moves.
 *
 *   It recomputes from the STORED ocr_json. No image is re-read and no model is called,
 *   so the only thing that changes is arithmetic that is now right.
 *
 * Two of the seven were corrected by an admin by hand. Reprocessing overrides that
 * judgement, which is why every change is written to audit_log with both sides and the
 * admin ones are called out on screen.
 *
 * Dry run:  node scripts/probe/fix-recompute-deposit-receipts.js
 * Apply:    node scripts/probe/fix-recompute-deposit-receipts.js --apply
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const APPLY = process.argv.includes('--apply')
const NOTE = 'amount recomputed 2026-09-04: bottle deposits are not taxed'

async function main() {
  const db = serviceClient()
  const { recomputeBudLightTotal } = loadTs('lib/classify-receipt.ts')
  const { recomputeLedgerForPeriod } = loadTs('lib/recompute-ledger.ts')

  const { data: receipts, error } = await db.from('receipts')
    .select('id, period, bam_id, cohort_id, status, bud_light_total_incl_tax, decision_reason, ocr_json, bams(first_name, last_name)')
  if (error) { fail(`receipts unreadable: ${error.message}`); return verdict('recompute deposit receipts') }

  const changed = []
  for (const r of receipts) {
    if (!r.ocr_json?.lines) continue
    const rc = recomputeBudLightTotal(r.ocr_json)
    const before = Number(r.bud_light_total_incl_tax ?? 0)
    if (Math.abs(rc.total - before) <= 0.01) continue
    changed.push({ r, rc, before })
  }

  if (!changed.length) { pass('every stored amount already matches the corrected arithmetic'); return verdict('recompute deposit receipts') }

  // Refuse the whole run if any affected invoice has left draft, rather than doing the
  // safe half and leaving somebody to work out which.
  let locked = 0
  for (const c of changed) {
    const { data: inv, error: iErr } = await db.from('invoices')
      .select('invoice_number, status').eq('bam_id', c.r.bam_id).eq('period', c.r.period)
    if (iErr) { fail(`invoice lookup failed: ${iErr.message}`); return verdict('recompute deposit receipts') }
    const sent = (inv ?? []).filter(i => i.status !== 'draft')
    if (sent.length) {
      fail(`${c.r.bams.first_name} ${c.r.bams.last_name} ${c.r.period}: ${sent.map(i => `${i.invoice_number} is ${i.status}`).join(', ')}`)
      locked++
    }
  }
  if (locked) {
    fail(`${locked} receipt(s) sit behind an invoice that has left draft. Nothing was written: void or reissue those first.`)
    return verdict('recompute deposit receipts')
  }
  pass(`all ${changed.length} affected invoices are still draft`)

  for (const { r, rc, before } of changed) {
    const who = `${r.bams.first_name} ${r.bams.last_name}`
    const adminHad = /corrected by admin/.test(String(r.decision_reason ?? ''))
    info(`${who} ${r.period}: $${before.toFixed(2)} -> $${rc.total.toFixed(2)} (${rc.basis})`)
    if (adminHad) info('  NOTE: an admin had set this amount by hand. Reprocessing overrides that.')

    if (!APPLY) { info('  dry run, nothing written'); continue }

    const reason = `${r.decision_reason ?? ''} | ${NOTE}: $${before.toFixed(2)} -> $${rc.total.toFixed(2)}`.replace(/^ \| /, '').slice(0, 1000)
    const { error: uErr } = await db.from('receipts')
      .update({ bud_light_total_incl_tax: rc.total, decision_reason: reason })
      .eq('id', r.id)
    if (uErr) { fail(`  receipt update failed: ${uErr.message}`); continue }

    const { data: after, error: bErr } = await db.from('receipts')
      .select('bud_light_total_incl_tax, status').eq('id', r.id).single()
    if (bErr || !after) { fail(`  wrote, but could not read back: ${bErr?.message ?? 'no row'}`); continue }
    if (Math.abs(Number(after.bud_light_total_incl_tax) - rc.total) > 0.001) {
      fail(`  read back says $${after.bud_light_total_incl_tax}, expected $${rc.total.toFixed(2)}`); continue
    }
    if (after.status !== r.status) { fail(`  status moved from ${r.status} to ${after.status}, which this script must never do`); continue }
    pass(`  receipt now $${Number(after.bud_light_total_incl_tax).toFixed(2)}, status still ${after.status}`)

    const { error: aErr } = await db.from('audit_log').insert({
      actor_id: null,
      actor_role: 'system',
      entity: 'receipts',
      entity_id: r.id,
      action: 'amount_recomputed_deposit_fix',
      before_json: { bud_light_total_incl_tax: before, admin_had_corrected: adminHad, decision_reason: r.decision_reason },
      after_json: { bud_light_total_incl_tax: rc.total, basis: rc.basis }
    })
    if (aErr) fail(`  audit_log insert failed: ${aErr.message}`)
  }

  if (!APPLY) { info('re-run with --apply to write'); return verdict('recompute deposit receipts') }

  // One ledger recompute per BAM and period, after every receipt in it has moved.
  const periods = [...new Set(changed.map(c => `${c.r.bam_id}|${c.r.cohort_id}|${c.r.period}`))]
  info('')
  for (const key of periods) {
    const [bamId, cohortId, period] = key.split('|')
    const who = changed.find(c => c.r.bam_id === bamId).r.bams
    const led = await recomputeLedgerForPeriod(db, { bamId, cohortId, period })
    if (!led.ok) { fail(`${who.first_name} ${who.last_name} ${period}: ledger failed: ${led.error}`); continue }
    pass(`${who.first_name} ${who.last_name} ${period}: spent $${led.spentCad.toFixed(2)}, paid $${led.paidCad.toFixed(2)}`)

    const { upsertDraftInvoice } = loadTs('lib/draft-invoice.ts')
    const inv = await upsertDraftInvoice(db, bamId, cohortId, period, { quietWhenLedgerPending: true })
    if (inv.ok) info(`   draft invoice rebuilt`)
    else info(`   invoice not rebuilt: ${inv.reason}`)
  }

  verdict('recompute deposit receipts')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('recompute deposit receipts') })
