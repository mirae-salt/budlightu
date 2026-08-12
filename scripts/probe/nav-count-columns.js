/**
 * Do the tables and columns the sidebar badges count actually exist?
 *
 * The badge counts live inside supabase-js string arguments -- table names and column names
 * -- which tsc cannot see. A wrong name there does not fail the build; it returns an error
 * object that, if the count code ignored it, would render as 0. And 0 is the one wrong
 * answer that means "nothing needs you".
 *
 * Written because the first draft of /api/admin/nav-counts guessed at three of these names.
 */
const { serviceClient, loadEnv, pass, fail, info, verdict } = require('./_lib')

const WANT = [
  { table: 'receipts', columns: ['bam_id'] },
  { table: 'banking_change_requests', columns: ['status'] },
  { table: 'portal_questions', columns: ['notified_at', 'answered_at', 'answered_by', 'answer'] },
  { table: 'bams', columns: ['wants_reminders'] },
  { table: 'student_reminders', columns: ['kind', 'sent_at', 'mode'] }
]

async function main() {
  loadEnv()
  const db = serviceClient()

  for (const { table, columns } of WANT) {
    // NOT a head-count: a head-count on a table that does not exist returns
    // { count: null, error: null }, and this probe used it to report that a nonexistent
    // table existed. Found 2026-08-12 by this script lying about bam_banking_requests.
    const { error: tblErr } = await db.from(table).select('id').limit(1)
    if (tblErr) {
      fail(`${table}: ${tblErr.message}`)
      continue
    }
    pass(`${table} exists`)

    for (const col of columns) {
      // Selecting the column by name is what proves it: a missing column errors here rather
      // than coming back as null.
      const { error } = await db.from(table).select(col).limit(1)
      if (error) fail(`${table}.${col}: ${error.message}`)
      else pass(`${table}.${col} exists`)
    }
  }

  // And the counts themselves, so the numbers on screen have been seen once.
  const { count: unmatched, error: uErr } = await db
    .from('receipts').select('id', { count: 'exact', head: true }).is('bam_id', null)
  if (uErr) fail(`unmatched count: ${uErr.message}`)
  else info(`unmatched receipts: ${unmatched}`)

  const { count: banking, error: bErr } = await db
    .from('banking_change_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending')
  if (bErr) fail(`banking count: ${bErr.message}`)
  else if (banking === null) fail('banking count came back null with no error, which is what a wrong table name looks like')
  else info(`pending banking changes: ${banking}`)

  const { count: questions, error: qErr } = await db
    .from('portal_questions').select('id', { count: 'exact', head: true }).is('answered_at', null)
  if (qErr) fail(`unanswered question count: ${qErr.message}`)
  else info(`unanswered questions: ${questions}`)

  verdict()
}

main().catch(e => { fail(e.message); verdict() })
