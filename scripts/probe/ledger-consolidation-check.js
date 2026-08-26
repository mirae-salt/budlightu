/**
 * Q: After folding four copies of the ledger arithmetic into one, does the money still
 *    come out the same?
 *
 * A refactor of a payment calculation is worth exactly as much as the numbers before
 * and after it. This recomputes every existing reimbursement_ledger row through the
 * consolidated function and diffs all nine money columns, including the ones nobody
 * looks at on screen (cap_snapshot_cad, carryover) but that later months read.
 *
 * WHY IT DOES NOT JUST RUN THE MONTHLY SWEEP
 *
 * The first version of this probe did, and reported PASS having verified nothing:
 * scheduler-audit selects cohorts whose start_date..end_date brackets the period, the
 * only cohort runs September to April, and the receipts under test are dated August.
 * Zero cohorts matched, the handler returned early, every row was trivially unchanged,
 * and the probe called that a pass. `processed: undefined` in the output was the tell.
 *
 * So it now does both, and says which is which: a direct recompute of each real row,
 * which always exercises the shared function, and the sweep, which is reported as
 * SKIPPED rather than passed when it turns out to have processed nobody.
 *
 * Safe to run: the recompute is idempotent. It re-derives from the receipts and
 * upserts the same values, never incrementing.
 *
 * Usage: node scripts/probe/ledger-consolidation-check.js [YYYY-MM-01 for the sweep]
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const COLUMNS = [
  'entitlement_cad', 'spent_cad', 'carryover_in_cad', 'carryover_out_cad',
  'paid_cad', 'spendable_cap_cad', 'cap_snapshot_cad', 'shortfall_flag', 'policy_version'
]

async function snapshot(db) {
  const { data, error } = await db.from('reimbursement_ledger')
    .select('bam_id, cohort_id, period, ' + COLUMNS.join(', '))
  if (error) throw new Error(`ledger read failed: ${error.message}`)
  const m = new Map()
  for (const r of data ?? []) m.set(`${r.bam_id}|${r.cohort_id}|${r.period}`, r)
  return m
}

function diff(before, after) {
  return COLUMNS
    .filter(c => String(before[c]) !== String(after[c]))
    .map(c => `${c}: ${String(before[c])} -> ${String(after[c])}`)
}

async function main() {
  const db = serviceClient()
  const { recomputeLedgerForPeriod } = loadTs('lib/recompute-ledger.ts')

  const before = await snapshot(db)
  if (before.size === 0) {
    fail('no ledger rows exist, so there is nothing to compare and this probe proves nothing')
    return verdict('ledger consolidation')
  }
  info(`${before.size} existing ledger row(s) to re-derive`)

  // ── 1. the real test: run each row back through the shared function ───────
  const names = new Map()
  const { data: bams } = await db.from('bams').select('id, first_name, last_name')
  for (const b of bams ?? []) names.set(b.id, `${b.first_name} ${b.last_name}`)

  let checked = 0
  let drifted = 0
  for (const [, row] of before) {
    const out = await recomputeLedgerForPeriod(db, {
      bamId: row.bam_id,
      cohortId: row.cohort_id,
      period: row.period
    })
    const who = names.get(row.bam_id) ?? row.bam_id.slice(0, 8)
    if (!out.ok) {
      fail(`${who} ${row.period}: the shared function refused - ${out.error}`)
      drifted++
      continue
    }
    checked++
    if (Math.abs(out.paidCad - Number(row.paid_cad)) > 0.005) {
      fail(`${who} ${row.period}: pays $${out.paidCad.toFixed(2)}, ledger holds $${Number(row.paid_cad).toFixed(2)}`)
      drifted++
    }
  }

  const after = await snapshot(db)
  for (const [key, a] of after) {
    const b = before.get(key)
    const who = names.get(a.bam_id) ?? key.slice(0, 8)
    if (!b) {
      fail(`${who} ${a.period}: a row appeared that a pure recompute should never create`)
      drifted++
      continue
    }
    const d = diff(b, a)
    if (d.length) {
      fail(`${who} ${a.period} CHANGED: ${d.join(' | ')}`)
      drifted++
    }
  }
  for (const key of before.keys()) {
    if (!after.has(key)) { fail(`${key.slice(0, 8)} disappeared`); drifted++ }
  }

  if (drifted === 0) {
    pass(`${checked} row(s) re-derived through the shared function, all ${COLUMNS.length} money columns identical`)
  }

  // ── 2. the sweep, reported honestly ───────────────────────────────────────
  const period = process.argv[2] || null
  const { handler: runAudit } = loadTs('supabase/functions/scheduler-audit/index.ts')
  const swept = await snapshot(db)
  const out = await runAudit(period ? { period } : {})

  if (out.processed === undefined) {
    // The cohort window did not include the period. Nothing ran, so nothing is proven.
    info(`sweep SKIPPED: no cohort covers ${period ?? 'this month'} (start_date..end_date). ` +
         'This is not a pass; the direct recompute above is what verified the function.')
  } else if (!out.ok) {
    fail(`sweep reported errors: ${JSON.stringify(out.errors)}`)
  } else if (out.processed === 0) {
    info('sweep ran but processed 0 BAMs, so it verified nothing')
  } else {
    const post = await snapshot(db)
    let sweepDrift = 0
    for (const [key, a] of post) {
      const b = swept.get(key)
      if (!b) { info(`sweep created a row for ${key.slice(0, 8)} ${a.period}: paid $${a.paid_cad}`); continue }
      const d = diff(b, a)
      if (d.length) { fail(`sweep CHANGED ${key.slice(0, 8)} ${a.period}: ${d.join(' | ')}`); sweepDrift++ }
    }
    if (sweepDrift === 0) pass(`sweep processed ${out.processed} BAM(s) for ${out.period} and changed no existing row`)
  }

  verdict('ledger consolidation')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('ledger consolidation') })
