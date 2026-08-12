/**
 * Does the reminder job behave with the switch off and the table not yet created?
 *
 * Migration 0025 has not been applied. The job must return "off" without ever touching
 * student_reminders, or the daily cron starts logging an error about a missing table on a
 * feature nobody has turned on. Reading the switch FIRST is what makes that true, and this is
 * the check that it actually does.
 */
const { loadEnv, pass, fail, info, verdict, loadTs } = require('./_lib')

async function main() {
  loadEnv()
  const { runStudentReminders } = loadTs('lib/run-student-reminders.ts')
  const r = await runStudentReminders(new Date(Date.UTC(2026, 8, 10, 13, 0, 0)))
  info(JSON.stringify(r))
  if (r.mode !== 'off') fail(`expected off, got ${r.mode}`)
  else pass('switch reads off')
  if (r.sent !== 0) fail(`sent ${r.sent} emails with the switch off`)
  else pass('nothing was sent')
  if (r.ran) fail('it ran despite being off')
  else pass('it did not run')
  if (String(r.note || '').includes('student_reminders')) {
    fail('it touched student_reminders, which does not exist yet')
  } else {
    pass('it never reached the table that has not been created')
  }
  verdict()
}

main().catch(e => { fail(e.message); verdict() })
