/**
 * Would the test question go out in tomorrow's digest, and remove it.
 *
 * The digest only picks rows with notified_at NULL, so a question that was already emailed is
 * skipped. That is the claim; this checks it against the actual row before deleting, because
 * "it will not be sent" without looking is the thing that keeps going wrong.
 */
const { serviceClient, loadEnv, pass, fail, info, verdict } = require('./_lib')

async function main() {
  loadEnv()
  const db = serviceClient()

  const { data, error } = await db
    .from('portal_questions')
    .select('id, question, submitted_at, notified_at')
    .order('submitted_at', { ascending: false })
  if (error) { fail(`read failed: ${error.message}`); return verdict() }

  const rows = data || []
  info(`${rows.length} question row(s) total`)
  const pending = rows.filter(r => !r.notified_at)
  for (const r of rows) {
    info(`${r.submitted_at}  "${String(r.question).slice(0, 30)}"  ${r.notified_at ? 'already emailed' : 'PENDING -> would be in the digest'}`)
  }
  if (pending.length === 0) pass('nothing is pending, so tomorrow\'s digest would not include any question')
  else info(`${pending.length} would be included`)

  if (!process.argv.includes('--delete-tests')) {
    info('read-only. Pass --delete-tests to remove rows whose text is only test filler.')
    return verdict()
  }

  // Only obvious filler, matched exactly, so a real question is never caught by this.
  const FILLER = ['test test', 'test', 'testing', 'test test test']
  const doomed = rows.filter(r => FILLER.includes(String(r.question).trim().toLowerCase()))
  if (doomed.length === 0) { info('no test filler rows found'); return verdict() }

  for (const r of doomed) info(`deleting: "${r.question}" (${r.id})`)
  const { error: delErr } = await db
    .from('portal_questions').delete().in('id', doomed.map(r => r.id))
  if (delErr) { fail(`delete failed: ${delErr.message}`); return verdict() }

  // Read back. A delete that reports success and leaves the row is the exact failure this
  // codebase already hit once with auth.users.
  const { data: after, error: aErr } = await db
    .from('portal_questions').select('id').in('id', doomed.map(r => r.id))
  if (aErr) { fail(`could not confirm the delete: ${aErr.message}`); return verdict() }
  if ((after || []).length > 0) fail(`${after.length} row(s) survived the delete`)
  else pass(`${doomed.length} test row(s) deleted and confirmed gone`)

  const { count, error: cErr } = await db
    .from('portal_questions').select('id', { count: 'exact', head: true })
  if (cErr) fail(`could not recount: ${cErr.message}`)
  else info(`questions remaining: ${count}`)

  verdict()
}

main().catch(e => { fail(e.message); verdict() })
