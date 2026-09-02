/**
 * Q: Who has made the three setup statements, and who is still owed the question?
 *
 * Shane Deen's 2026-08-27 review, items B (work authorisation), E (banking ownership)
 * and F (automated processing). Everyone onboarding from 2026-09-02 answers these on the
 * form. Anyone who onboarded earlier gets a one-time prompt on the dashboard, because
 * otherwise their rows stay empty and nobody notices.
 *
 * This is the "check the consent status" view. It is a script rather than an admin page
 * on purpose: the answer is only needed by Mirae and Shane, and a screen for it would be
 * one more thing in Robin's way.
 *
 * A NULL is not a "no". It means the question was never put to that person.
 *
 * Read only. Usage: node scripts/probe/attestations.js
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

async function main() {
  const db = serviceClient()
  const { ATTESTATION_VERSION } = loadTs('lib/attestations.ts')

  // The columns the code writes have to exist, or onboarding fails at the last step for
  // all 57 invite holders at once.
  const COLS = [
    'work_auth_attested_at', 'work_auth_version',
    'banking_attested_at', 'banking_version',
    'consent_ai_training', 'consent_ai_training_at', 'consent_ai_training_version'
  ]
  let schemaOk = true
  for (const col of COLS) {
    const { error } = await db.from('bams').select(col).limit(1)
    if (error) { fail(`bams.${col} is missing (${error.code}): migration 0033 has not been applied`); schemaOk = false }
  }
  if (!schemaOk) {
    fail('onboarding WILL FAIL for everyone until 0033 is applied, because the API writes these columns')
    return verdict('attestations')
  }
  pass(`all ${COLS.length} attestation columns exist`)

  const { data: bams, error } = await db.from('bams')
    .select('first_name, last_name, is_test, status, work_auth_attested_at, banking_attested_at, consent_ai_training, work_auth_version')
  if (error) { fail(`bams unreadable: ${error.message}`); return verdict('attestations') }

  const real = bams.filter(b => !b.is_test)
  const answered = real.filter(b => b.work_auth_attested_at && b.banking_attested_at)
  const owed = real.filter(b => !b.work_auth_attested_at || !b.banking_attested_at)

  info(`${real.length} real BAMs: ${answered.length} answered, ${owed.length} not yet asked`)

  const active = owed.filter(b => b.status === 'active')
  const pending = owed.filter(b => b.status !== 'active')
  if (active.length) {
    // These are the ones the dashboard prompt exists for: already onboarded, so the form
    // will never ask them again.
    info(`${active.length} already onboarded, so they get the dashboard prompt on next sign-in:`)
    for (const b of active) info(`   ${b.first_name} ${b.last_name}`)
  }
  if (pending.length) {
    info(`${pending.length} still pending, so they answer on the onboarding form itself`)
  }

  for (const b of answered) {
    const ai = b.consent_ai_training === true ? 'training: yes'
      : b.consent_ai_training === false ? 'training: no'
      : 'training: not asked'
    info(`   ${b.first_name} ${b.last_name}: v${b.work_auth_version}, ${ai}`)
  }

  // A row carrying one attestation but not the other means a write landed half way.
  const half = real.filter(b => Boolean(b.work_auth_attested_at) !== Boolean(b.banking_attested_at))
  if (half.length === 0) pass('no row has one attestation without the other')
  else for (const b of half) fail(`${b.first_name} ${b.last_name} has only one of the two, so a write landed half way`)

  // Old wording still on a row is fine and expected; it is the point of versioning. This
  // just says so out loud rather than letting it look like a mismatch.
  const stale = answered.filter(b => b.work_auth_version && b.work_auth_version !== ATTESTATION_VERSION)
  if (stale.length) info(`${stale.length} row(s) hold an older wording version, which is correct: they agreed to that text`)

  verdict('attestations')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('attestations') })
