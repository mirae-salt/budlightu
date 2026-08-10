/**
 * fix- prefix: this MUTATES production. Prints before, changes, reads back, prints after.
 *
 * Turns OFF `cohorts.first_cohort_all_review`.
 *
 * With it on, EVERY receipt goes to Robin: 58 BAMs x 8 months is 464 manual clicks
 * a season, which is the 5-hours-a-month problem this system exists to remove. The
 * real flags stay active either way (no Bud Light lines found, low OCR confidence,
 * duplicate, at or near the cap, an amount the server could not corroborate), so a
 * receipt still reaches her when something is actually wrong with it.
 *
 * Mirae, 2026-08-10: off. `lib/policy.ts` now also defaults to false, but the COHORT
 * column wins at runtime (see supabase/functions/scheduler-audit and
 * app/api/receipts/ocr), so the stored value is what decides.
 *
 * Usage:  node scripts/probe/fix-review-everything-off.js           (dry run)
 *         node scripts/probe/fix-review-everything-off.js --apply   (writes)
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

async function main() {
  const apply = process.argv.includes('--apply')
  const db = serviceClient()

  const { data: before, error: readErr } = await db
    .from('cohorts').select('id, name, first_cohort_all_review')
  if (readErr) { fail('cohorts read failed: ' + readErr.message); return verdict('review-everything') }

  console.log('BEFORE:')
  for (const c of before) console.log(`  ${c.name.padEnd(14)} first_cohort_all_review=${c.first_cohort_all_review}`)
  console.log('')

  const on = before.filter(c => c.first_cohort_all_review !== false)
  if (on.length === 0) { pass('review-everything is already off for every cohort'); return verdict('review-everything') }

  if (!apply) {
    info(`${on.length} cohort(s) would be turned off: ${on.map(c => c.name).join(', ')}`)
    info('re-run with --apply to write')
    return verdict('review-everything (dry run)')
  }

  for (const c of on) {
    const { error } = await db.from('cohorts')
      .update({ first_cohort_all_review: false })
      .eq('id', c.id)
      .eq('first_cohort_all_review', c.first_cohort_all_review)
    if (error) fail(`${c.name}: ${error.message}`)
  }

  // Read back with a fresh query rather than trusting the update (rule A12).
  const { data: after, error: afterErr } = await db
    .from('cohorts').select('name, first_cohort_all_review')
  if (afterErr) { fail('read-back failed: ' + afterErr.message); return verdict('review-everything') }

  console.log('AFTER:')
  for (const c of after) console.log(`  ${c.name.padEnd(14)} first_cohort_all_review=${c.first_cohort_all_review}`)
  console.log('')

  const stillOn = after.filter(c => c.first_cohort_all_review !== false)
  if (stillOn.length) fail(`still on: ${stillOn.map(c => c.name).join(', ')}`)
  else pass(`off for all ${after.length} cohort(s). Clean receipts will auto-pass; flagged ones still reach Robin.`)

  verdict('review-everything')
}
main()
