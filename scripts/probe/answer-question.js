/**
 * Can a question actually be marked answered and reopened?
 *
 * The API route does this, but the route needs a logged-in admin, and what is worth checking
 * here is the database half: that answered_at can be written, read back, and cleared. Before
 * migration 0026 every one of these writes would have failed with "column does not exist", and
 * the page would have shown a button that did nothing.
 *
 * Creates its own throwaway question, uses that, and deletes it. It never touches a real one.
 */
const { serviceClient, loadEnv, pass, fail, info, verdict } = require('./_lib')

async function main() {
  loadEnv()
  const db = serviceClient()

  const before = await db.from('portal_questions').select('id', { count: 'exact', head: true })
  if (before.error) { fail(`count failed: ${before.error.message}`); return verdict('answer question') }
  const startCount = before.count
  info(`questions before: ${startCount}`)

  // bam_id null on purpose: it is the case the page also has to survive, and it means this row
  // is attached to nobody real.
  const { data: made, error: insErr } = await db.from('portal_questions')
    .insert({ bam_id: null, question: 'PROBE: delete me' })
    .select('id, answered_at')
  if (insErr) { fail(`insert failed: ${insErr.message}`); return verdict('answer question') }
  const id = made[0].id
  if (made[0].answered_at !== null) fail('a new question was created already answered')
  else pass('a new question starts unanswered')

  // ---- mark answered, with text ----
  const { data: ans, error: ansErr } = await db.from('portal_questions')
    .update({ answered_at: new Date().toISOString(), answer: 'PROBE reply' })
    .eq('id', id)
    .select('answered_at, answer')
  if (ansErr) { fail(`answer write failed: ${ansErr.message}`); await cleanup(db, id); return verdict('answer question') }
  if (!ans[0].answered_at) fail('answered_at came back null after being written')
  else pass('answered_at was written and read back')
  if (ans[0].answer !== 'PROBE reply') fail(`answer text came back as ${JSON.stringify(ans[0].answer)}`)
  else pass('the reply text was stored')

  // ---- it must drop out of the open list ----
  const openWhile = await db.from('portal_questions')
    .select('id', { count: 'exact', head: true }).is('answered_at', null).eq('id', id)
  if (openWhile.error) fail(`open filter failed: ${openWhile.error.message}`)
  else if (openWhile.count !== 0) fail('an answered question still counts as open')
  else pass('an answered question is no longer counted as open')

  // ---- reopen ----
  const { data: re, error: reErr } = await db.from('portal_questions')
    .update({ answered_at: null, answered_by: null })
    .eq('id', id)
    .select('answered_at, answer')
  if (reErr) { fail(`reopen failed: ${reErr.message}`); await cleanup(db, id); return verdict('answer question') }
  if (re[0].answered_at !== null) fail('answered_at survived the reopen')
  else pass('reopen cleared answered_at')
  // The record of what was already said must survive, or reopening loses it.
  if (re[0].answer !== 'PROBE reply') fail('reopening wiped the reply that had been sent')
  else pass('reopen kept the reply text')

  await cleanup(db, id)

  const after = await db.from('portal_questions').select('id', { count: 'exact', head: true })
  if (after.error) fail(`recount failed: ${after.error.message}`)
  else if (after.count !== startCount) fail(`count changed: ${startCount} -> ${after.count}`)
  else pass(`table is back to ${after.count} row(s)`)

  verdict('answer question')
}

async function cleanup(db, id) {
  const { error } = await db.from('portal_questions').delete().eq('id', id)
  if (error) { fail(`CLEANUP FAILED, delete row ${id} by hand: ${error.message}`); return }
  const { data } = await db.from('portal_questions').select('id').eq('id', id)
  if ((data || []).length > 0) fail(`CLEANUP FAILED, row ${id} survived the delete`)
  else pass('probe row deleted and confirmed gone')
}

main().catch(e => { fail(e.message); verdict('answer question') })
