/**
 * Does editing the support-recipient list actually change who gets emailed?
 *
 * Read only by default. `--roundtrip` writes a throwaway address, reads it back, checks that
 * recipientsForArrival would include it, and RESTORES the original value. It prints the
 * original first, so if the restore fails there is a line to put back by hand.
 *
 * Written because the claim being made is "Robin can change who receives support questions
 * without a deploy", and that claim spans a UI, an API route, a JSON column and a pure
 * function. Every part typechecks in isolation. Only a round trip shows the chain works.
 */
const { serviceClient, loadEnv, pass, fail, info, verdict, loadTs } = require('./_lib')

const PROBE_ADDRESS = 'probe.delete.me@example.com'

async function main() {
  loadEnv()
  const db = serviceClient()
  const notify = loadTs('lib/question-notify.ts')
  const {
    QUESTION_NOTIFY_KEY,
    parseQuestionNotify,
    withExtraRecipients,
    recipientsForArrival,
    parseRecipientList
  } = notify

  const { data, error } = await db
    .from('policy').select('value_json').eq('key', QUESTION_NOTIFY_KEY).limit(1)
  if (error) {
    fail(`could not read the policy row: ${error.message}`)
    return verdict()
  }

  const original = (data || [])[0] ? (data[0].value_json ?? null) : null
  // Printed BEFORE anything is written. A restore that fails silently is worse than no
  // restore at all if the value it overwrote was never recorded.
  info(`current value_json: ${JSON.stringify(original)}`)

  const settings = parseQuestionNotify(original)
  info(`default frequency: ${settings.default}`)
  info(`per-admin overrides: ${JSON.stringify(settings.byEmail)}`)
  info(`extra recipients: ${JSON.stringify(settings.extraRecipients || [])}`)

  // Who would actually be emailed by the next question.
  const { data: users, error: uErr } = await db.auth.admin.listUsers({ perPage: 1000 })
  if (uErr) {
    fail(`admin list unreadable: ${uErr.message}`)
  } else {
    const admins = (users.users || [])
      .filter(u => {
        const role = (u.app_metadata && u.app_metadata.role) || (u.user_metadata && u.user_metadata.role)
        return role === 'admin' || role === 'super_admin' || role === 'program_admin'
      })
      .map(u => (u.email || '').trim().toLowerCase())
      .filter(Boolean)
    info(`admins: ${admins.length} (${admins.join(', ')})`)
    const now = recipientsForArrival(settings, admins)
    if (now.length === 0) {
      info('a new question right now would email NOBODY. It would only appear on the Questions page.')
    } else {
      pass(`a new question right now would email: ${now.join(', ')}`)
    }
  }

  if (!process.argv.includes('--roundtrip')) {
    info('read-only. Pass --roundtrip to write a throwaway address and restore it.')
    return verdict()
  }

  // ---- round trip ----
  const parsed = parseRecipientList([...(settings.extraRecipients || []), PROBE_ADDRESS].join('\n'))
  if (!parsed.ok) {
    fail(`parseRecipientList rejected its own output: ${JSON.stringify(parsed.bad)}`)
    return verdict()
  }
  const next = withExtraRecipients(settings, parsed.emails)

  const { data: saved, error: wErr } = await db
    .from('policy')
    .upsert({ key: QUESTION_NOTIFY_KEY, value_json: next, updated_at: new Date().toISOString() },
      { onConflict: 'key' })
    .select('value_json')
  if (wErr) {
    fail(`write failed: ${wErr.message}`)
    return verdict()
  }

  const stored = parseQuestionNotify((saved || [])[0] && saved[0].value_json)
  if (!(stored.extraRecipients || []).includes(PROBE_ADDRESS)) {
    fail(`read-back does not contain the address that was written: ${JSON.stringify(stored.extraRecipients)}`)
  } else {
    pass('the written address came back on read')
  }
  // The frequencies must be exactly where they were. This is the failure the route guards
  // against, so it is worth seeing once against real data.
  if (JSON.stringify(stored.byEmail) !== JSON.stringify(settings.byEmail)) {
    fail(`per-admin frequencies moved: ${JSON.stringify(stored.byEmail)}`)
  } else {
    pass('nobody\'s frequency moved')
  }
  if (!recipientsForArrival(stored, []).includes(PROBE_ADDRESS)) {
    fail('the address is stored but recipientsForArrival would not email it')
  } else {
    pass('recipientsForArrival would email it, even with no admins on each')
  }

  // ---- restore ----
  const { data: back, error: rErr } = await db
    .from('policy')
    .upsert({ key: QUESTION_NOTIFY_KEY, value_json: settings, updated_at: new Date().toISOString() },
      { onConflict: 'key' })
    .select('value_json')
  if (rErr) {
    fail(`RESTORE FAILED: ${rErr.message}. Put the original value printed above back by hand.`)
    return verdict()
  }
  const restored = parseQuestionNotify((back || [])[0] && back[0].value_json)
  if ((restored.extraRecipients || []).includes(PROBE_ADDRESS)) {
    fail('RESTORE FAILED: the probe address is still stored. Remove it on /admin/settings.')
  } else {
    pass('restored: the probe address is gone')
  }

  verdict()
}

main().catch(e => { fail(e.message); verdict() })
