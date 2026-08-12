/**
 * Did the question email actually go out, and does the current setting explain it?
 *
 * Mirae saw an email to Robin in the Resend log and pushed back on my claim that "a new
 * question right now would email nobody". Both can be true if the email went out BEFORE the
 * frequency was set to daily, and the only way to know is the two timestamps, not an
 * argument. `--set-nb-off` additionally puts nb@ilovesalt.com on 'off' at Mirae's request.
 */
const { serviceClient, loadEnv, pass, fail, info, verdict, loadTs } = require('./_lib')

async function main() {
  loadEnv()
  const db = serviceClient()
  const { QUESTION_NOTIFY_KEY, parseQuestionNotify, withModeFor, modeFor } =
    loadTs('lib/question-notify.ts')

  const { data: pol, error: pErr } = await db
    .from('policy').select('value_json, updated_at').eq('key', QUESTION_NOTIFY_KEY).limit(1)
  if (pErr) { fail(`policy read: ${pErr.message}`); return verdict() }
  const row = (pol || [])[0]
  if (!row) { info('no question_notify row exists at all'); }
  else {
    info(`setting last changed: ${row.updated_at}`)
    info(`setting value:        ${JSON.stringify(row.value_json)}`)
  }

  const { data: qs, error: qErr } = await db
    .from('portal_questions')
    .select('id, question, submitted_at, notified_at')
    .order('submitted_at', { ascending: false })
    .limit(5)
  if (qErr) { fail(`questions read: ${qErr.message}`); return verdict() }

  for (const q of qs || []) {
    const stamped = q.notified_at
      ? `notified_at ${q.notified_at}  <- an email WAS sent for this one`
      : 'notified_at NULL              <- no email was recorded for this one'
    info(`${q.submitted_at}  "${String(q.question).slice(0, 24)}"  ${stamped}`)
  }

  // The actual question: is the email older than the setting?
  const newest = (qs || [])[0]
  if (newest && row && newest.notified_at) {
    const mailed = new Date(newest.notified_at).getTime()
    const changed = new Date(row.updated_at).getTime()
    if (mailed < changed) {
      pass('the email went out BEFORE the setting changed, so both observations hold')
    } else {
      fail('the email went out AFTER the setting changed, so my reading of the setting is wrong')
    }
  } else if (newest && !newest.notified_at) {
    info('the newest question has no notified_at, so nothing was recorded as emailed for it')
  }

  if (process.argv.includes('--set-nb-off')) {
    const settings = parseQuestionNotify(row && row.value_json)
    const next = withModeFor(settings, 'nb@ilovesalt.com', 'off')
    const { data: saved, error: wErr } = await db
      .from('policy')
      .upsert({ key: QUESTION_NOTIFY_KEY, value_json: next, updated_at: new Date().toISOString() },
        { onConflict: 'key' })
      .select('value_json')
    if (wErr) { fail(`could not set nb to off: ${wErr.message}`); return verdict() }
    const stored = parseQuestionNotify((saved || [])[0] && saved[0].value_json)
    if (modeFor(stored, 'nb@ilovesalt.com') !== 'off') {
      fail(`read-back says nb is ${modeFor(stored, 'nb@ilovesalt.com')}, not off`)
    } else {
      pass('nb@ilovesalt.com is now off')
    }
    // Nobody else may have moved. This is normally done through the UI, which only ever
    // writes the caller's own entry; doing it here bypasses that, so the check matters more.
    for (const [email, mode] of Object.entries(settings.byEmail || {})) {
      if (email === 'nb@ilovesalt.com') continue
      if (stored.byEmail[email] !== mode) fail(`${email} moved from ${mode} to ${stored.byEmail[email]}`)
    }
    info(`now stored: ${JSON.stringify(stored)}`)
  }

  verdict()
}

main().catch(e => { fail(e.message); verdict() })
