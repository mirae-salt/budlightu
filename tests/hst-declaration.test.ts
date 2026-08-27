/**
 * The GST/HST declaration.
 *
 * Onboarding used to ask for an "HST number (optional)" and nothing else, so tax was $0
 * on every invoice because nobody typed anything, not because nobody was registered.
 * These tests are mostly about the difference between those two, and about the one
 * outcome that must never happen: a stored declaration that says "registered" with no
 * usable number behind it, or a stored number nobody attested to.
 */
import { describe, it, expect } from 'vitest'
import {
  validateHstDeclaration,
  normalizeHstNumber,
  HST_DECLARATION_VERSION,
  HST_COPY
} from '../lib/hst-declaration'

describe('not registered', () => {
  it('is a valid declaration and stores no number', () => {
    const r = validateHstDeclaration({ status: 'not_registered', attested: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.status).toBe('not_registered')
    expect(r.number).toBeNull()
    expect(r.version).toBe(HST_DECLARATION_VERSION)
  })

  it('discards a number left behind after switching the radio back', () => {
    // The form hides the input rather than clearing it. The declaration is what was
    // chosen, not what is sitting in a hidden field, and a number stored here would
    // silently put tax on an invoice for somebody who said they are not registered.
    const r = validateHstDeclaration({
      status: 'not_registered',
      number: '123456789 RT 0001',
      attested: true
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.number).toBeNull()
  })
})

describe('registered', () => {
  it('accepts a well-formed number and normalizes it', () => {
    const r = validateHstDeclaration({ status: 'registered', number: '123456789RT0001', attested: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.number).toBe('123456789 RT 0001')
  })

  it('accepts the spacing and hyphens people actually type', () => {
    for (const raw of [
      '123456789 RT 0001',
      '123456789RT0001',
      '123456789-RT-0001',
      '  123456789 rt 0001  ',
      '123456789 rt0001'
    ]) {
      expect(normalizeHstNumber(raw)).toBe('123456789 RT 0001')
    }
  })

  it('refuses when the number is missing', () => {
    const r = validateHstDeclaration({ status: 'registered', number: '   ', attested: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/Enter your GST\/HST number/)
  })

  it('refuses a number that is not the CRA format', () => {
    for (const bad of ['12345', '123456789', 'RT0001', '1234567890 RT 0001', '123456789 RQ 0001', 'not a number']) {
      const r = validateHstDeclaration({ status: 'registered', number: bad, attested: true })
      expect(r.ok, `should refuse ${bad}`).toBe(false)
    }
  })
})

describe('what it refuses outright', () => {
  it('an unanswered question, which is not the same as not registered', () => {
    // The whole point of the change. A blank must never resolve to a declaration.
    for (const status of [undefined, null, '', 'maybe', 0, true]) {
      const r = validateHstDeclaration({ status, attested: true })
      expect(r.ok, `should refuse status=${String(status)}`).toBe(false)
    }
  })

  it('a declaration nobody ticked the box for', () => {
    for (const attested of [undefined, false, null, 'yes', 1]) {
      const r = validateHstDeclaration({ status: 'not_registered', attested })
      expect(r.ok, `should refuse attested=${String(attested)}`).toBe(false)
    }
  })

  it('never returns a number without a registered status', () => {
    // Belt and braces on the invariant that decides whether tax appears.
    const cases = [
      { status: 'not_registered', number: '123456789 RT 0001', attested: true },
      { status: 'not_registered', number: 'anything', attested: true }
    ]
    for (const c of cases) {
      const r = validateHstDeclaration(c)
      if (r.ok) expect(r.number).toBeNull()
    }
  })
})

describe('the wording is versioned, because somebody signs it', () => {
  it('carries a version that goes on the record', () => {
    expect(HST_DECLARATION_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('states the contractor relationship and that no tax is withheld', () => {
    expect(HST_COPY.intro).toMatch(/independent contractor/i)
    expect(HST_COPY.intro).toMatch(/does not withhold/i)
  })

  it('describes the small-supplier threshold the way the CRA measures it', () => {
    // Four consecutive calendar quarters, not "annual revenue". It is a statement
    // somebody signs, so it should be right.
    expect(HST_COPY.notRegistered).toMatch(/\$30,000/)
    expect(HST_COPY.notRegistered).toMatch(/four consecutive calendar quarters/i)
  })

  it('asks them to report a change, with a deadline', () => {
    expect(HST_COPY.attestation).toMatch(/10 days/)
  })
})
