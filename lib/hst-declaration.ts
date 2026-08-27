/**
 * The ambassador's own statement about GST/HST registration.
 *
 * WHY A DECLARATION AND NOT A TEXT BOX
 *
 * Onboarding used to ask for an "HST number (optional)" and nothing else. Everybody
 * left it blank, so every invoice came out with $0 tax and Robin was right that tax is
 * $0 today. But the REASON was "nobody typed anything", not "nobody is registered", and
 * those are different things to have on file. An empty box is not a statement. It also
 * meant one student typing a number would quietly put tax on their invoice, with no
 * decision made by anyone.
 *
 * So the question is asked properly and the answer is recorded. "I am not registered"
 * is a thing the contractor said, dated and versioned, the same way the program terms
 * already are (`consent_terms_at` / `consent_terms_version`).
 *
 * Proposed by Shane Deen 2026-08-27, from a worker-classification review. It is a
 * better answer than the one I had, which was to delete the field.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not verify the number against the CRA registry. That is a separate build
 * (an admin screen, somewhere to keep the evidence, and a rule that tax stays at zero
 * until a human has checked) and is deliberately not in this change.
 *
 * The tax calculation in lib/invoice-payload is untouched: `bam.hstNumber ? computeHst
 * (...) : 0`. A "not registered" declaration stores no number, so tax stays $0 by the
 * same path it does today. Nothing about how invoices are priced changes here.
 *
 * THE WORDING IS A LEGAL STATEMENT
 *
 * Every string below is text a contractor ticks a box against. It is kept in one file,
 * as constants, so that when somebody who owns Salt's contractor agreements revises it,
 * it is one edit and a version bump rather than a hunt through two page components.
 * `HST_DECLARATION_VERSION` is what gets stored, so a row always says which wording the
 * person actually agreed to.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */

/**
 * Bump when any user-visible string below changes. Stored per BAM so an old row is
 * never silently reinterpreted under new wording.
 */
export const HST_DECLARATION_VERSION = '2026-08-27'

export type HstStatus = 'not_registered' | 'registered'

/**
 * Copy, in one place. Drafted from Shane's 2026-08-27 note.
 *
 * The small-supplier line says "over four consecutive calendar quarters" rather than
 * "annual revenue", because that is how the CRA threshold is actually measured and this
 * is a statement someone signs.
 */
export const HST_COPY = {
  heading: 'Your business and tax status',
  intro:
    'You are engaged as an independent contractor. You are responsible for your own income tax, CPP, ' +
    'and any GST/HST obligations. Salt XC does not withhold tax from your fees.',
  question: 'GST/HST registration',
  notRegistered:
    'I am not registered for GST/HST (small supplier, under $30,000 in revenue over four consecutive ' +
    'calendar quarters). No HST will appear on my invoices.',
  registered: 'I am registered for GST/HST.',
  numberLabel: 'My GST/HST number',
  numberPlaceholder: '123456789 RT 0001',
  attestation:
    'I confirm the above is accurate, and I will tell Salt XC in writing within 10 days if my ' +
    'registration status changes.',
  /** Shown under the registered option so the delay is not a surprise later. */
  verificationNote:
    'A registered number is checked before any HST is added to an invoice, so your first invoice may ' +
    'show $0 tax while that happens.'
} as const

export type HstDeclarationInput = {
  status?: unknown
  number?: unknown
  attested?: unknown
}

export type HstDeclarationResult =
  | { ok: true; status: HstStatus; number: string | null; version: string }
  | { ok: false; message: string }

/**
 * The CRA business number format: nine digits, the RT program identifier, four digits.
 * Spaces and hyphens are accepted on the way in and normalized out, because that is how
 * it is printed on a CRA letter and retyping it exactly is not a test worth setting.
 */
const HST_NUMBER = /^(\d{9})\s*-?\s*(RT)\s*-?\s*(\d{4})$/i

export function normalizeHstNumber(raw: string): string | null {
  const m = HST_NUMBER.exec(String(raw ?? '').trim())
  if (!m) return null
  return `${m[1]} RT ${m[3]}`
}

/**
 * Validate the declaration as a whole. Rejects rather than guesses.
 *
 * The important refusal is the last one: "registered" with no usable number cannot be
 * stored, because it would leave a record claiming registration that no invoice can act
 * on and that nobody can verify.
 */
export function validateHstDeclaration(input: HstDeclarationInput): HstDeclarationResult {
  const status = input.status
  if (status !== 'not_registered' && status !== 'registered') {
    return { ok: false, message: 'Choose whether you are registered for GST/HST.' }
  }
  if (input.attested !== true) {
    return { ok: false, message: 'Please confirm your GST/HST status is accurate.' }
  }

  if (status === 'not_registered') {
    // Any number typed before switching the radio back is discarded on purpose. The
    // declaration is what was chosen, not what is left in a hidden input.
    return { ok: true, status, number: null, version: HST_DECLARATION_VERSION }
  }

  const raw = typeof input.number === 'string' ? input.number : ''
  if (!raw.trim()) {
    return { ok: false, message: 'Enter your GST/HST number, or select that you are not registered.' }
  }
  const normalized = normalizeHstNumber(raw)
  if (!normalized) {
    return {
      ok: false,
      message: 'That does not look like a GST/HST number. It should be nine digits, then RT, then four digits.'
    }
  }
  return { ok: true, status, number: normalized, version: HST_DECLARATION_VERSION }
}
