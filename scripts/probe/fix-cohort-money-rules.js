/**
 * Corrects cohorts whose money rules were left on the superseded 2026-07-15 model.
 *
 * `Class of 2027` was created while rollover was still the plan, and kept
 * rollover_mode='accumulate' and first_cohort_all_review=true after Robin replaced
 * that model on 2026-08-04 (flat $150 a month, no carryover) and after auto-approve
 * became the default. The cohorts screen reads these columns directly, which is why
 * it printed "carries over".
 *
 * What each change does:
 *   rollover_mode -> forfeit
 *     lib/recompute-ledger.ts passes this to computeMonthlyReimbursement. On
 *     'accumulate', a BAM who spends $80 in September gets a $220 cap in October.
 *   first_cohort_all_review -> false
 *     app/api/receipts/ocr reads it and lib/classify-receipt.ts forces EVERY receipt
 *     to 'review' when it is on, regardless of what the classifier found. Turning it
 *     off does not turn off review: no-Bud-Light, low confidence, duplicates,
 *     at-or-near-cap totals and uncorroborated amounts all still flag.
 *
 * Prints before and after for every row it touches, and reads the row back from the
 * database rather than trusting the update to have done what it said.
 *
 * Dry run:  node scripts/probe/fix-cohort-money-rules.js
 * Apply:    node scripts/probe/fix-cohort-money-rules.js --apply
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

const WANT = { rollover_mode: 'forfeit', first_cohort_all_review: false }
const APPLY = process.argv.includes('--apply')

async function main() {
  const db = serviceClient()

  const { data: cohorts, error } = await db.from('cohorts')
    .select('id, name, rollover_mode, first_cohort_all_review')
    .order('start_date')
  if (error) { fail(`cohorts unreadable: ${error.message}`); return verdict('fix cohort money rules') }

  const wrong = cohorts.filter(c =>
    c.rollover_mode !== WANT.rollover_mode || c.first_cohort_all_review !== WANT.first_cohort_all_review)

  if (!wrong.length) { pass('every cohort already matches the confirmed rules'); return verdict('fix cohort money rules') }

  for (const c of wrong) {
    // The before values, recorded before anything is written. Reverting is guesswork
    // without them.
    info(`${c.name}`)
    info(`  before: rollover_mode=${JSON.stringify(c.rollover_mode)} first_cohort_all_review=${JSON.stringify(c.first_cohort_all_review)}`)
    info(`  after:  rollover_mode="forfeit" first_cohort_all_review=false`)

    if (!APPLY) { info('  dry run, nothing written. Re-run with --apply'); continue }

    const { error: uErr } = await db.from('cohorts').update(WANT).eq('id', c.id)
    if (uErr) { fail(`  update failed: ${uErr.message}`); continue }

    // Read back. "Success" from the client is not evidence that the row changed.
    const { data: after, error: rErr } = await db.from('cohorts')
      .select('rollover_mode, first_cohort_all_review').eq('id', c.id).single()
    if (rErr || !after) { fail(`  wrote, but could not read back: ${rErr?.message ?? 'no row'}`); continue }
    if (after.rollover_mode === WANT.rollover_mode && after.first_cohort_all_review === WANT.first_cohort_all_review) {
      pass(`  read back: rollover_mode=${after.rollover_mode} first_cohort_all_review=${after.first_cohort_all_review}`)
    } else {
      fail(`  read back does NOT match: ${JSON.stringify(after)}`)
    }
  }

  if (APPLY) info('now re-run: node scripts/probe/cohort-money-rules.js')
  verdict('fix cohort money rules')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('fix cohort money rules') })
