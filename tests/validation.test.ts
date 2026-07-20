import { describe, it, expect } from 'vitest'
import {
  validateInstitution, validateTransit, validateAccount,
  isValidHst, INSTITUTION_REGEX, TRANSIT_REGEX, ACCOUNT_REGEX
} from '../lib/validation'

describe('leading-zero preservation regex', () => {
  it('institution: exactly 3 digits, leading zeros ok', () => {
    expect(INSTITUTION_REGEX.test('003')).toBe(true)
    expect(INSTITUTION_REGEX.test('001')).toBe(true)
    expect(INSTITUTION_REGEX.test('623')).toBe(true)
    expect(INSTITUTION_REGEX.test('3')).toBe(false)     // stripped!
    expect(INSTITUTION_REGEX.test('0003')).toBe(false)  // too long
  })
  it('transit: exactly 5 digits, leading zeros ok', () => {
    expect(TRANSIT_REGEX.test('05162')).toBe(true)
    expect(TRANSIT_REGEX.test('03352')).toBe(true)
    expect(TRANSIT_REGEX.test('722')).toBe(false)    // Avery case (would need 00722)
    expect(TRANSIT_REGEX.test('00722')).toBe(true)
  })
  it('account: 6–12 digits, leading zeros ok', () => {
    expect(ACCOUNT_REGEX.test('6902025')).toBe(true)
    expect(ACCOUNT_REGEX.test('000012345')).toBe(true)
    expect(ACCOUNT_REGEX.test('12345')).toBe(false)  // too short
  })
})

describe('validators throw on bad input (HARD FAIL)', () => {
  it('validateInstitution rejects stripped zeros', () => {
    expect(() => validateInstitution('3')).toThrow(/institution/)
    expect(() => validateInstitution(3 as unknown)).toThrow(/institution/)
    expect(() => validateInstitution(null as unknown)).toThrow(/institution/)
  })
  it('validateTransit rejects stripped zeros (real Avery/Kira/Emma cases)', () => {
    expect(() => validateTransit('722')).toThrow(/transit/)
    expect(() => validateTransit('919')).toThrow(/transit/)
    expect(() => validateTransit('2214')).toThrow(/transit/)
  })
  it('validateAccount rejects too-short strings', () => {
    expect(() => validateAccount('1234')).toThrow(/account/)
  })
  it('validators are silent on valid values', () => {
    expect(() => validateInstitution('003')).not.toThrow()
    expect(() => validateTransit('05162')).not.toThrow()
    expect(() => validateAccount('6902025')).not.toThrow()
  })
})

describe('isValidHst', () => {
  it('accepts standard Canadian HST', () => {
    expect(isValidHst('123456789RT0001')).toBe(true)
    expect(isValidHst('123456789 RT 0001')).toBe(true)
  })
  it('rejects malformed', () => {
    expect(isValidHst('123456789')).toBe(false)
    expect(isValidHst('junk')).toBe(false)
    expect(isValidHst(undefined)).toBe(false)
  })
})
