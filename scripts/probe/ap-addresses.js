/**
 * Q: If an invoice were sent RIGHT NOW, which inbox would it land in?
 *
 * WHY THIS EXISTS
 * ---------------
 * The AP recipient became editable on /admin/settings on 2026-08-13, which moves the value out
 * of a deploy and into a form. That is the point, and it also means the failure mode is now
 * completely invisible: the send SUCCEEDS and the address is wrong. Nothing in a log, nothing
 * on screen, nobody notices until a student is not paid.
 *
 * So this asks the question the settings page cannot: not "what is in the box" but "what will
 * the sender resolve". It calls resolveApAddresses, the SAME function both senders call, via
 * loadTs. A probe that reimplements the rule agrees with itself, not with the app.
 *
 * Run it before and after any change to the AP addresses.
 *
 * Usage: node scripts/probe/ap-addresses.js
 */
const { serviceClient, loadTs, pass, fail, info, verdict } = require('./_lib')

/** Visible representation of a string, so a trailing space or a BOM is not invisible here too. */
function shown(s) {
  return JSON.stringify(s)
}

async function main() {
  const db = serviceClient()
  const mod = loadTs('lib/ap-addresses.ts')
  const { resolveApAddresses, envApAddresses, apAddressProblems, AP_EMAIL_KEY } = mod

  // What is actually stored, printed separately from what resolves. The two differ when the
  // row is absent (env wins) or unusable (the resolver refuses), and knowing WHICH matters.
  const { data: rows, error: rowErr } = await db
    .from('policy').select('value_json, updated_at, updated_by').eq('key', AP_EMAIL_KEY).limit(1)

  if (rowErr) {
    fail(`policy read failed: ${rowErr.message}`)
  } else if ((rows ?? []).length === 0) {
    info(`no policy row for "${AP_EMAIL_KEY}" yet, so the environment is in charge`)
  } else {
    const r = rows[0]
    info(`policy row present, last changed ${r.updated_at ?? 'unknown'} by ${r.updated_by ?? 'unknown'}`)
  }

  // The environment, always printed. It is the fallback, and a broken fallback is worth seeing
  // before it is the only thing left.
  const env = envApAddresses()
  info(`env  to  ${shown(env.to)}`)
  info(`env  cc  ${env.cc.length ? env.cc.map(shown).join(', ') : '(none)'}`)
  const envProblems = apAddressProblems({ to: env.to, cc: env.cc })
  if (envProblems.length > 0) {
    // Not a FAIL on its own: the policy row may be in charge and perfectly fine. But this is
    // exactly the BOM-class fault that used to be invisible until the first real send.
    for (const p of envProblems) info(`env  PROBLEM  ${p}`)
  }

  const resolved = await resolveApAddresses(db)

  if (!resolved.ok) {
    fail(`a send would be REFUSED right now: ${resolved.error}`)
    info('that is the intended direction: refuse rather than guess a recipient')
    return verdict('AP addresses')
  }

  pass(`resolved from ${resolved.source}`)
  console.log('')
  console.log(`  An invoice sent now would go TO:  ${shown(resolved.to)}`)
  for (const [i, c] of resolved.cc.entries()) {
    console.log(`                             CC ${i + 1}:  ${shown(c)}`)
  }
  if (resolved.cc.length === 0) console.log('                              CC:  (none)')
  console.log('')

  const problems = apAddressProblems({ to: resolved.to, cc: resolved.cc })
  if (problems.length > 0) {
    for (const p of problems) fail(p)
  } else {
    pass('every resolved address passes the same check the sender runs')
  }

  if (resolved.source === 'env') {
    info('still the deployed default. Nobody has set this on /admin/settings.')
  }
  // The BAM is added to CC at send time when they are verified and consented (lib/bam-cc.ts),
  // so the list above is not the whole recipient list for a real invoice.
  info('the BAM is CC\'d on their own invoice at send time and is not shown here')
  info('read-only: nothing was written')

  verdict('AP addresses')
}
main()
