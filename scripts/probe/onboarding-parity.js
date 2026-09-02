/**
 * Q: Do BOTH onboarding pages send everything their API now demands?
 *
 * There are two onboarding forms and two write paths:
 *
 *   /portal/onboarding          -> /api/onboarding/complete
 *   /portal/onboarding/[token]  -> /api/onboarding -> onboarding-ingest   (the invite link)
 *
 * On 2026-09-02 the work-authorisation and banking-ownership attestations were added to
 * the signed-in form and to BOTH validators, and the invite-link form was missed. Every
 * one of the 57 students holding an invite would have been refused at the last step of
 * onboarding, with a message about a checkbox their page never showed them. It typechecks
 * cleanly, because the form object is spread into the request and TypeScript never sees
 * the two ends meet.
 *
 * This reads both page sources for the fields their validator requires. Crude on purpose:
 * it needs no browser, no login and no database, so it can run on every change.
 *
 * Read only. Usage: node scripts/probe/onboarding-parity.js
 */
const fs = require('fs')
const path = require('path')
const { ROOT, pass, fail, info, verdict, loadTs } = require('./_lib')

/** Fields the server refuses a submission without. Extend this when a validator does. */
const REQUIRED_FIELDS = [
  'work_auth',
  'banking_owner',
  'consent_terms',
  'consent_ap_cc',
  'hst_status',
  'hst_attested'
]

/** Optional, but a page that never offers it records "never asked" for everybody. */
const OPTIONAL_FIELDS = ['ai_training']

const PAGES = [
  { label: 'signed-in form', file: 'app/portal/onboarding/page.tsx' },
  { label: 'invite-link form', file: 'app/portal/onboarding/[token]/page.tsx' }
]

function main() {
  const sources = PAGES.map(p => {
    const full = path.join(ROOT, p.file)
    if (!fs.existsSync(full)) { fail(`${p.file} not found`); return null }
    return { ...p, src: fs.readFileSync(full, 'utf8') }
  })
  if (sources.some(s => s === null)) return verdict('onboarding parity')

  for (const field of REQUIRED_FIELDS) {
    const missing = sources.filter(s => !s.src.includes(field))
    if (missing.length === 0) {
      pass(`both forms carry "${field}"`)
    } else {
      for (const m of missing) {
        fail(`${m.label} (${m.file}) never mentions "${field}", which its API requires: onboarding fails at submit`)
      }
    }
  }

  for (const field of OPTIONAL_FIELDS) {
    const missing = sources.filter(s => !s.src.includes(field))
    if (missing.length === 0) pass(`both forms offer "${field}"`)
    else for (const m of missing) info(`${m.label} does not offer "${field}", so those rows record "never asked"`)
  }

  // Both pages spread the whole form object into the request. If that ever changes to a
  // hand-picked list, a field can be in the state and still never be sent.
  for (const s of sources) {
    if (/form:\s*\{\s*\.\.\.form/.test(s.src)) {
      pass(`${s.label} spreads the whole form into the request`)
    } else {
      fail(`${s.label} no longer spreads ...form, so check each field is actually sent`)
    }
  }

  // And the validator itself, exercised rather than assumed: this is the exact payload
  // the invite-link page produced before it was fixed.
  const { validateAttestations } = loadTs('lib/attestations.ts')
  const withoutTicks = validateAttestations({ workAuth: undefined, bankingOwner: undefined })
  if (withoutTicks.ok === false) {
    pass('a submission missing the attestations is refused, so a page that forgets them cannot pass silently')
  } else {
    fail('the validator accepted a submission with no attestations at all')
  }

  verdict('onboarding parity')
}

try { main() } catch (e) { fail(String(e && e.message ? e.message : e)); verdict('onboarding parity') }
