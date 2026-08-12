/**
 * Unmatched onboarding submissions, and remove the test ones.
 *
 * An unmatched submission is a form somebody filled in whose email does not match any roster
 * row, so nothing was written to the roster and it is parked for a human to look at. Read-only
 * unless --delete-tests.
 */
const { serviceClient, loadEnv, pass, fail, info, verdict } = require('./_lib')

async function main() {
  loadEnv()
  const db = serviceClient()

  const { data, error } = await db
    .from('onboarding_submissions')
    .select('id, submitted_email, submitted_at, flag_reason, status, matched_bam_id')
    .order('submitted_at', { ascending: false })
  if (error) { fail(`read failed: ${error.message}`); return verdict('purge test onboarding') }

  const rows = data || []
  info(`${rows.length} submission row(s)`)
  for (const r of rows) {
    info(`${r.submitted_at}  email=${JSON.stringify(r.submitted_email)}  status=${r.status}  reason=${r.flag_reason || 'none'}`)
  }
  if (rows.length === 0) { pass('nothing parked'); return verdict('purge test onboarding') }

  if (!process.argv.includes('--delete-tests')) {
    info('read-only. Pass --delete-tests to remove rows with an EMPTY submitted email.')
    return verdict('purge test onboarding')
  }

  // Only rows whose submitted email is empty. A real submission always carries the address the
  // person typed, so this cannot catch one. The row Mirae asked about had form= (nothing).
  const doomed = rows.filter(r => !String(r.submitted_email || '').trim())
  if (doomed.length === 0) { info('no rows with an empty submitted email'); return verdict('purge test onboarding') }

  for (const r of doomed) info(`deleting ${r.id} (empty submitted email, ${r.submitted_at})`)
  const { error: delErr } = await db
    .from('onboarding_submissions').delete().in('id', doomed.map(r => r.id))
  if (delErr) { fail(`delete failed: ${delErr.message}`); return verdict('purge test onboarding') }

  const { data: after, error: aErr } = await db
    .from('onboarding_submissions').select('id').in('id', doomed.map(r => r.id))
  if (aErr) { fail(`could not confirm: ${aErr.message}`); return verdict('purge test onboarding') }
  if ((after || []).length > 0) fail(`${after.length} row(s) survived`)
  else pass(`${doomed.length} row(s) deleted and confirmed gone`)

  const { count } = await db.from('onboarding_submissions').select('id', { count: 'exact', head: true })
  info(`submissions remaining: ${count}`)
  verdict('purge test onboarding')
}

main().catch(e => { fail(e.message); verdict('purge test onboarding') })
