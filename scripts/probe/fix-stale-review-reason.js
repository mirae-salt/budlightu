/**
 * Removes the "first_cohort_all_review" clause from receipts whose cohort no longer has
 * that policy on.
 *
 * The reason string is written once, when the receipt is classified, and never revisited.
 * `Class of 2027` had first_cohort_all_review on for the few hours between the cohort
 * being created and the setting being corrected on 2026-09-02 at 16:20:48 UTC. One
 * receipt landed at 16:19:53, fifty-five seconds inside that window, and its stored
 * reason still tells Robin every receipt is reviewed for the first three months. That is
 * not true any more, and a review queue that explains itself with a policy nobody is
 * running is worse than one that says nothing.
 *
 * It only edits the text. Status is untouched, and any other clause on the receipt is
 * left exactly as written, so a receipt that had real reasons stays in review for them.
 * A receipt whose ONLY reason was this one is left alone entirely and reported: deciding
 * on its own that such a receipt should now auto-pass would be re-judging money from a
 * text-cleanup script.
 *
 * Dry run:  node scripts/probe/fix-stale-review-reason.js
 * Apply:    node scripts/probe/fix-stale-review-reason.js --apply
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

const CLAUSE = 'first_cohort_all_review'
const APPLY = process.argv.includes('--apply')

async function main() {
  const db = serviceClient()

  const { data: cohorts, error: cErr } = await db.from('cohorts').select('id, name, first_cohort_all_review')
  if (cErr) { fail(`cohorts unreadable: ${cErr.message}`); return verdict('stale review reason') }
  const policyOff = new Set(cohorts.filter(c => c.first_cohort_all_review === false).map(c => c.id))

  const { data: receipts, error: rErr } = await db.from('receipts')
    .select('id, uploaded_at, status, decision_reason, bams(first_name, last_name, cohort_id)')
  if (rErr) { fail(`receipts unreadable: ${rErr.message}`); return verdict('stale review reason') }

  const stale = receipts.filter(r =>
    String(r.decision_reason || '').includes(CLAUSE) && policyOff.has(r.bams?.cohort_id))

  if (!stale.length) { pass('no receipt carries a review reason its cohort no longer applies'); return verdict('stale review reason') }

  for (const r of stale) {
    const who = `${r.bams.first_name} ${r.bams.last_name}`
    const parts = String(r.decision_reason).split(' | ')
    const kept = parts.filter(p => !p.startsWith(CLAUSE))

    info(`${who}, uploaded ${r.uploaded_at}, status ${r.status}`)
    info(`  removing: ${parts.find(p => p.startsWith(CLAUSE))}`)

    if (kept.length === 0) {
      // Its only reason was the retired policy. Rewriting that to an empty string would
      // leave a receipt sitting in review with no stated reason at all, and clearing the
      // status is a money decision this script has no business making.
      info('  SKIPPED: that was its only reason, so a human decides this one')
      continue
    }
    for (const k of kept) info(`  keeping:  ${k}`)

    if (!APPLY) { info('  dry run, nothing written'); continue }

    const next = kept.join(' | ')
    const { error: uErr } = await db.from('receipts').update({ decision_reason: next }).eq('id', r.id)
    if (uErr) { fail(`  update failed: ${uErr.message}`); continue }

    const { data: after, error: bErr } = await db.from('receipts')
      .select('decision_reason, status').eq('id', r.id).single()
    if (bErr || !after) { fail(`  wrote, but could not read back: ${bErr?.message ?? 'no row'}`); continue }
    if (after.decision_reason === next && after.status === r.status) {
      pass(`  read back clean, status still ${after.status}`)
    } else {
      fail(`  read back does not match: ${JSON.stringify(after)}`)
    }
  }

  verdict('stale review reason')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('stale review reason') })
