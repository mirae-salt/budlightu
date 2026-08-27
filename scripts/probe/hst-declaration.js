/**
 * Q: Does the GST/HST declaration actually get captured, and is tax still $0?
 *
 * Onboarding used to ask for an "HST number (optional)" and nothing else. Tax was $0 on
 * every invoice, but the reason on file was "nobody typed anything" rather than "nobody
 * is registered". This checks that the new declaration is stored, and that nothing about
 * how invoices are priced moved while adding it.
 *
 * Read only. Usage: node scripts/probe/hst-declaration.js
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

async function main() {
  const db = serviceClient()

  // 1. The columns the code writes have to exist, or onboarding fails at the last step.
  for (const col of ['hst_status', 'hst_declared_at', 'hst_declaration_version']) {
    const { error } = await db.from('bams').select(col).limit(1)
    if (error) fail(`bams.${col} is missing (${error.code}) - migration 0031 has not been applied`)
    else pass(`bams.${col} exists`)
  }

  // 2. Who has declared what.
  const { data: bams, error: bErr } = await db.from('bams')
    .select('first_name, last_name, is_test, hst_status, hst_declared_at, hst_declaration_version')
  if (bErr) { fail(`bams unreadable: ${bErr.message}`); return verdict('hst declaration') }

  const declared = bams.filter(b => b.hst_status)
  const never = bams.filter(b => !b.hst_status)
  info(`${bams.length} BAMs: ${declared.length} declared, ${never.length} never asked`)
  for (const b of declared) {
    info(`  ${b.first_name} ${b.last_name}: ${b.hst_status} (v${b.hst_declaration_version}, ${String(b.hst_declared_at).slice(0, 10)})`)
  }
  if (never.length) {
    // NULL is not 'not_registered'. These rows onboarded before the question existed and
    // were deliberately not backfilled, because inventing a declaration nobody made is
    // the opposite of what the column is for.
    info(`  ${never.length} row(s) with NULL, meaning never asked. Not the same as "not registered".`)
  }

  // 3. Anyone registered? That is the only case where tax can appear on an invoice.
  const registered = declared.filter(b => b.hst_status === 'registered')
  if (registered.length === 0) {
    pass('nobody has declared GST/HST registration, so every invoice stays at $0 tax')
  } else {
    info(`${registered.length} registered. Their invoices WILL carry tax once a number is on file:`)
    for (const b of registered) info(`  ${b.first_name} ${b.last_name}`)
  }

  // 4. The invoices themselves. This is the observation that matters: the declaration
  //    was added without moving any money.
  const { data: inv, error: iErr } = await db.from('invoices')
    .select('invoice_number, status, payload_json')
  if (iErr) { fail(`invoices unreadable: ${iErr.message}`); return verdict('hst declaration') }
  const taxed = inv.filter(i => Number(i.payload_json?.tax ?? 0) !== 0)
  if (taxed.length === 0) pass(`all ${inv.length} invoice(s) carry $0 tax`)
  else for (const i of taxed) fail(`${i.invoice_number} carries $${Number(i.payload_json.tax).toFixed(2)} tax`)

  // 5. The declaration validator itself, exercised rather than assumed.
  const { validateHstDeclaration, HST_DECLARATION_VERSION } = loadTs('lib/hst-declaration.ts')
  const cases = [
    ['blank answer', { attested: true }, false],
    ['not registered, attested', { status: 'not_registered', attested: true }, true],
    ['not registered, NOT attested', { status: 'not_registered', attested: false }, false],
    ['registered with no number', { status: 'registered', attested: true }, false],
    ['registered with a good number', { status: 'registered', number: '123456789RT0001', attested: true }, true]
  ]
  let bad = 0
  for (const [label, input, want] of cases) {
    const got = validateHstDeclaration(input).ok
    if (got !== want) { fail(`validator: ${label} returned ok=${got}, expected ${want}`); bad++ }
  }
  if (bad === 0) pass(`validator behaves on all ${cases.length} cases (wording version ${HST_DECLARATION_VERSION})`)

  // A "not registered" answer must never carry a number through. That value is what
  // decides whether tax lands on a payment document.
  const leak = validateHstDeclaration({ status: 'not_registered', number: '123456789RT0001', attested: true })
  if (leak.ok && leak.number === null) pass('a "not registered" answer discards any number left in the form')
  else fail(`a "not registered" answer kept a number: ${JSON.stringify(leak)}`)

  verdict('hst declaration')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('hst declaration') })
