/**
 * fix- prefix: this MUTATES production. Prints before, changes, reads back, prints after.
 *
 * Q it fixes: the live cohort is `rollover_mode = 'accumulate'`, but Robin confirmed
 * on 2026-08-04 that there is NO rollover — flat $150 per month, reset independently,
 * unspent amounts forfeited. `lib/policy.ts` defaults to 'forfeit', but
 * supabase/functions/scheduler-audit reads the COHORT value, not the default, so the
 * stored value is what would decide the money.
 *
 * With 'accumulate', lib/reimbursement.ts carries unspent balance forward:
 * spendableCap grows past $150 and paidThisMonth can exceed the cap. No harm has
 * occurred yet (reimbursement_ledger is empty), which is why this is worth doing now
 * rather than after the first audit run.
 *
 * Usage:  node scripts/probe/fix-rollover-mode.js           (dry run, shows what it would do)
 *         node scripts/probe/fix-rollover-mode.js --apply   (writes)
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

const WANT = 'forfeit'

async function main() {
  const apply = process.argv.includes('--apply')
  const db = serviceClient()

  const { data: before, error: readErr } = await db
    .from('cohorts').select('id, name, rollover_mode, reimbursement_max')
  if (readErr) { fail('cohorts read failed: ' + readErr.message); return verdict('rollover mode') }

  console.log('BEFORE:')
  for (const c of before) console.log(`  ${c.name.padEnd(14)} rollover_mode=${c.rollover_mode}  max=${c.reimbursement_max}`)
  console.log('')

  const wrong = before.filter(c => c.rollover_mode !== WANT)
  if (wrong.length === 0) { pass(`every cohort is already '${WANT}'`); return verdict('rollover mode') }

  if (!apply) {
    info(`${wrong.length} cohort(s) would change to '${WANT}': ${wrong.map(c => c.name).join(', ')}`)
    info('re-run with --apply to write')
    return verdict('rollover mode (dry run)')
  }

  for (const c of wrong) {
    const { error: updErr } = await db.from('cohorts')
      .update({ rollover_mode: WANT }).eq('id', c.id).eq('rollover_mode', c.rollover_mode)
    if (updErr) { fail(`${c.name}: ${updErr.message}`); continue }
  }

  // Read back by a fresh query rather than trusting the update (rule A12).
  const { data: after, error: afterErr } = await db
    .from('cohorts').select('id, name, rollover_mode')
  if (afterErr) { fail('read-back failed: ' + afterErr.message); return verdict('rollover mode') }

  console.log('AFTER:')
  for (const c of after) console.log(`  ${c.name.padEnd(14)} rollover_mode=${c.rollover_mode}`)
  console.log('')

  const stillWrong = after.filter(c => c.rollover_mode !== WANT)
  if (stillWrong.length) fail(`still not '${WANT}': ${stillWrong.map(c => c.name).join(', ')}`)
  else pass(`all ${after.length} cohort(s) are '${WANT}'`)

  info('the cohorts admin screen cannot show or edit this field; that is a separate gap')
  verdict('rollover mode')
}
main()
