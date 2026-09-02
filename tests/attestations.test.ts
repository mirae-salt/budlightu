/**
 * The three setup statements (Shane Deen, 2026-08-27: items B, E and F).
 *
 * These are records of things a person agreed to, so the interesting cases are the ones
 * where a missing field could quietly become a recorded "no" or a recorded "yes".
 */
import { describe, it, expect } from 'vitest'
import {
  validateAttestations,
  ATTESTATION_VERSION,
  WORK_AUTH_COPY,
  BANKING_ATTESTATION_COPY,
  AI_DISCLOSURE_COPY
} from '../lib/attestations'

describe('validateAttestations', () => {
  it('accepts both required ticks', () => {
    const r = validateAttestations({ workAuth: true, bankingOwner: true })
    expect(r.ok).toBe(true)
  })

  it('refuses when work authorisation is not ticked', () => {
    const r = validateAttestations({ workAuth: false, bankingOwner: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/legally entitled/i)
  })

  it('refuses when banking ownership is not ticked', () => {
    const r = validateAttestations({ workAuth: true, bankingOwner: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/bank account/i)
  })

  it('refuses a missing field rather than reading it as false', () => {
    // "they did not tick it" and "the form did not send it" are different failures.
    // Both stop the submission, but neither is silently recorded.
    expect(validateAttestations({ bankingOwner: true }).ok).toBe(false)
    expect(validateAttestations({ workAuth: true }).ok).toBe(false)
    expect(validateAttestations({}).ok).toBe(false)
  })

  it('refuses truthy values that are not literally true', () => {
    // A string "false" is truthy. Coercing here would record an attestation nobody made.
    for (const v of ['true', 'false', 1, 'on', {}, []]) {
      expect(validateAttestations({ workAuth: v, bankingOwner: true }).ok).toBe(false)
      expect(validateAttestations({ workAuth: true, bankingOwner: v }).ok).toBe(false)
    }
  })

  it('keeps declined and never-asked apart for the optional consent', () => {
    const agreed = validateAttestations({ workAuth: true, bankingOwner: true, aiTraining: true })
    const declined = validateAttestations({ workAuth: true, bankingOwner: true, aiTraining: false })
    const notAsked = validateAttestations({ workAuth: true, bankingOwner: true })

    expect(agreed.ok && agreed.aiTraining).toBe(true)
    expect(declined.ok && declined.aiTraining).toBe(false)
    expect(notAsked.ok && notAsked.aiTraining).toBe(null)
  })

  it('treats a junk value for the optional consent as never asked', () => {
    const r = validateAttestations({ workAuth: true, bankingOwner: true, aiTraining: 'yes' })
    expect(r.ok && r.aiTraining).toBe(null)
  })

  it('refusing the optional consent does not block the required ones', () => {
    const r = validateAttestations({ workAuth: true, bankingOwner: true, aiTraining: false })
    expect(r.ok).toBe(true)
  })
})

describe('the wording', () => {
  it('names self-employment in the work authorisation tick', () => {
    // A study permit's off-campus allowance generally does not cover self-employment,
    // so someone can tick a generic "I may work in Canada" honestly and still be wrong.
    expect(WORK_AUTH_COPY.checkbox).toMatch(/self-employ/i)
    expect(WORK_AUTH_COPY.checkbox).toMatch(/permit/i)
  })

  it('gives an out rather than only a demand', () => {
    expect(WORK_AUTH_COPY.help).toMatch(/not sure/i)
  })

  it('asks the optional consent as a question, so a no is an available answer', () => {
    expect(AI_DISCLOSURE_COPY.trainingQuestion).toMatch(/\?$/)
    expect(AI_DISCLOSURE_COPY.trainingHelp).toMatch(/say no/i)
  })

  it('tells people a human reviews and that they can ask for one', () => {
    // Quebec Law 25 s.12.1. Robin confirmed 8 BAMs at Quebec schools.
    const all = AI_DISCLOSURE_COPY.body.join(' ')
    expect(all).toMatch(/a person reviews/i)
    expect(all).toMatch(/ask a person/i)
  })

  it('has no em dash anywhere', () => {
    const strings = [
      WORK_AUTH_COPY.heading, WORK_AUTH_COPY.checkbox, WORK_AUTH_COPY.help,
      BANKING_ATTESTATION_COPY.checkbox,
      AI_DISCLOSURE_COPY.heading, AI_DISCLOSURE_COPY.trainingQuestion,
      AI_DISCLOSURE_COPY.trainingCheckbox, AI_DISCLOSURE_COPY.trainingHelp,
      ...AI_DISCLOSURE_COPY.body
    ]
    for (const s of strings) expect(s).not.toContain('—')
  })

  it('is versioned, so an old row is never reread under new wording', () => {
    expect(ATTESTATION_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
