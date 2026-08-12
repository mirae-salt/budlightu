/**
 * Whose institution number wins: the student's.
 *
 * Decided by Mirae on 2026-08-12, reversing what I had built earlier the same day. That
 * version discarded what the student typed and stored our table's value, warning only to a
 * console log nobody reads. It means a student whose bank we have listed wrong gets their
 * money routed by OUR mistake, silently, and it hides the mistake so it survives. Our
 * 32-row table has already been wrong twice: nine credit-union numbers corrected in one
 * pass, and EQ Bank missing entirely from July until today.
 *
 * So: ask once, then believe them.
 */
import { describe, it, expect } from 'vitest'
import { decideInstitution } from '../lib/institution-confirm'

describe('agreement, or nothing to disagree with', () => {
  it('stores it when it matches our table', () => {
    const d = decideInstitution({ bankName: 'TD Canada Trust', submitted: '004' })
    expect(d.kind).toBe('store')
    if (d.kind === 'store') expect(d.institutionNo).toBe('004')
  })

  it('stores it when the bank is not in our table at all', () => {
    // The EQ Bank case from July. No student should be blocked by our list being
    // incomplete, and there is nothing to disagree with.
    const d = decideInstitution({ bankName: 'Some Local Credit Union', submitted: '842' })
    expect(d.kind).toBe('store')
    if (d.kind === 'store') expect(d.institutionNo).toBe('842')
  })
})

describe('disagreement stops the write and asks', () => {
  const d = decideInstitution({ bankName: 'TD Canada Trust', submitted: '703' })

  it('does not store', () => {
    expect(d.kind).toBe('confirm')
  })

  it('carries both numbers so the student can see the difference', () => {
    if (d.kind !== 'confirm') throw new Error('expected confirm')
    expect(d.submitted).toBe('703')
    expect(d.ours).toBe('004')
    expect(d.bankName).toBe('TD Canada Trust')
  })

  it('asks plainly rather than lecturing', () => {
    if (d.kind !== 'confirm') throw new Error('expected confirm')
    expect(d.message).toContain('703')
    expect(d.message).toMatch(/double-check/i)
    // The heading already says "Is this right?", so the body must not repeat it.
    expect(d.message).not.toMatch(/is this right/i)
    // It must NOT tell them our number is the correct one. It is not necessarily.
    expect(d.message).not.toMatch(/should be|must be|incorrect/i)
  })
})

describe('confirmed means confirmed', () => {
  it('stores exactly what they typed, not our table value', () => {
    // The whole point. If this ever returns 004 here, a student who checked their own
    // void cheque has been overruled by our list.
    const d = decideInstitution({ bankName: 'TD Canada Trust', submitted: '703', confirmed: true })
    expect(d.kind).toBe('store')
    if (d.kind === 'store') expect(d.institutionNo).toBe('703')
  })

  it('is checked before the lookup, so a second submission is not re-argued', () => {
    const d = decideInstitution({ bankName: 'RBC Royal Bank', submitted: '999', confirmed: true })
    expect(d.kind).toBe('store')
    if (d.kind === 'store') expect(d.institutionNo).toBe('999')
  })
})

describe('whitespace', () => {
  it('is trimmed before comparing, so " 004" is not treated as a disagreement', () => {
    const d = decideInstitution({ bankName: 'TD Canada Trust', submitted: ' 004 ' })
    expect(d.kind).toBe('store')
    if (d.kind === 'store') expect(d.institutionNo).toBe('004')
  })
})

describe('the four banks whose displayName used to break the lookup', () => {
  // lookupBank could not resolve these from the value our own dropdown sends, so all four
  // would have been treated as "bank not in the table" and skipped the check entirely.
  // Alterna was worse: it resolved to a DIFFERENT institution. Fixed in lib/banks.ts the
  // same day; asserted here because this function is what depends on it.
  it.each([
    ['EQ Bank (Equitable Bank)', '623'],
    ['SCU (Steinbach Credit Union)', '879'],
    ["President's Choice Financial", '320'],
    ['Alterna Bank', '608']
  ])('%s compares against %s', (bankName, ours) => {
    const agree = decideInstitution({ bankName, submitted: ours })
    expect(agree.kind).toBe('store')

    const disagree = decideInstitution({ bankName, submitted: '111' })
    expect(disagree.kind).toBe('confirm')
    if (disagree.kind === 'confirm') expect(disagree.ours).toBe(ours)
  })
})
