/**
 * Q: If two different people submit the same receipt, does anything catch it?
 *
 * Until 2026-08-26 the answer was no, and nobody knew: both duplicate checks compared
 * a BAM against themselves (app/api/portal/upload on sha256, app/api/receipts/ocr on
 * store/date/total), while lib/classify-receipt documented its `duplicateHash` input as
 * a cross-BAM signal. Robin assumed in the testing session that sharing one receipt
 * would be flagged. It would not have been.
 *
 * This runs the SAME query and the SAME function the OCR route now runs, so a pass here
 * is evidence about the wiring and not only about the unit tests. It writes nothing.
 *
 * It also answers the question that matters before September: are there real (non-test)
 * BAMs whose receipts collide with each other right now?
 *
 * Usage: node scripts/probe/duplicate-across-bams.js
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

async function main() {
  const db = serviceClient()
  const { findCrossBamDuplicate } = loadTs('lib/duplicate-receipt.ts')

  const { data: bams, error: bamErr } = await db.from('bams')
    .select('id, first_name, last_name, is_test')
  if (bamErr) { fail(`bams unreadable: ${bamErr.message}`); return verdict('cross-BAM duplicates') }

  const testIds = new Set(bams.filter(b => b.is_test).map(b => b.id))
  const nameOf = new Map(bams.map(b => [b.id, `${b.first_name} ${b.last_name}`.trim()]))
  info(`${bams.length} BAMs: ${testIds.size} test, ${bams.length - testIds.size} real`)

  const { data: receipts, error: rErr } = await db.from('receipts')
    .select('id, bam_id, period, sha256, ocr_json, status')
    .neq('status', 'rejected')
  if (rErr) { fail(`receipts unreadable: ${rErr.message}`); return verdict('cross-BAM duplicates') }

  const asCandidate = r => ({
    id: r.id,
    bamId: r.bam_id,
    bamName: nameOf.get(r.bam_id) ?? null,
    period: r.period,
    sha256: r.sha256,
    store: r.ocr_json?.store ?? null,
    date: r.ocr_json?.date ?? null,
    grandTotal: r.ocr_json?.grand_total ?? null
  })

  // ── 1. the live question: does anything real collide today? ───────────────
  const real = receipts.filter(r => !testIds.has(r.bam_id))
  let hits = 0
  for (const r of real) {
    const m = findCrossBamDuplicate(
      { receiptId: r.id, bamId: r.bam_id, sha256: r.sha256,
        store: r.ocr_json?.store ?? null, date: r.ocr_json?.date ?? null,
        grandTotal: r.ocr_json?.grand_total ?? null },
      real.filter(o => o.id !== r.id).map(asCandidate)
    )
    if (m) { fail(`${nameOf.get(r.bam_id)} receipt ${r.id.slice(0, 8)}: ${m.reason}`); hits++ }
  }
  if (hits === 0) pass(`no collisions among ${real.length} receipt(s) from real BAMs`)

  // ── 2. does the detector actually fire? A check that has never returned true
  //       on any input is indistinguishable from a check that is broken. ──────
  const sample = receipts[0]
  if (!sample) {
    fail('no receipts at all, so the detector could not be exercised and this proves nothing')
    return verdict('cross-BAM duplicates')
  }
  const planted = findCrossBamDuplicate(
    { receiptId: 'probe-subject', bamId: 'probe-bam-not-a-real-id',
      sha256: sample.sha256, store: sample.ocr_json?.store ?? null,
      date: sample.ocr_json?.date ?? null, grandTotal: sample.ocr_json?.grand_total ?? null },
    [asCandidate(sample)]
  )
  if (planted) pass(`detector fires on a planted copy of a real receipt (${planted.kind} match)`)
  else fail('detector did NOT fire on an exact copy of a real receipt - it is not working')

  // ── 3. test accounts are excluded, both directions ────────────────────────
  const aTest = receipts.find(r => testIds.has(r.bam_id))
  if (!aTest) {
    info('no test-account receipts exist, so the exclusion could not be exercised here')
  } else {
    const leaked = findCrossBamDuplicate(
      { receiptId: 'probe-subject', bamId: 'probe-real-bam',
        sha256: aTest.sha256, store: aTest.ocr_json?.store ?? null,
        date: aTest.ocr_json?.date ?? null, grandTotal: aTest.ocr_json?.grand_total ?? null },
      // Exactly what the route passes: test BAMs filtered out before the call.
      receipts.filter(o => !testIds.has(o.bam_id)).map(asCandidate)
    )
    if (leaked) fail(`a test account's receipt reached a real decision: ${leaked.reason}`)
    else pass("a test account's receipt is not a candidate against a real BAM")
  }

  if (real.length === 0) {
    info('every BAM is currently a test account, so part 1 compared nothing. ' +
         'Re-run after the September cohort is loaded.')
  }

  verdict('cross-BAM duplicates')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('cross-BAM duplicates') })
