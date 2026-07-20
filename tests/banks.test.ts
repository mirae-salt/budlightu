import { describe, it, expect } from 'vitest'
import { normalizeBankName, lookupBank, BANK_SEED } from '../lib/banks'

describe('normalizeBankName', () => {
  it('strips "the "', () => {
    expect(normalizeBankName('The Toronto-Dominion')).toBe('toronto-dominion')
  })
  it('strips "canada trust"', () => {
    expect(normalizeBankName('TD Canada Trust')).toBe('td')
  })
  it('strips "bank"', () => {
    expect(normalizeBankName('Royal Bank')).toBe('royal')
  })
  it('collapses whitespace and lowercases', () => {
    expect(normalizeBankName('  CIBC   ')).toBe('cibc')
  })
})

describe('lookupBank — seed integrity', () => {
  it('every seed has a 3-digit institution number (leading zeros)', () => {
    for (const b of BANK_SEED) {
      expect(b.institutionNo).toMatch(/^\d{3}$/)
    }
  })

  const cases: Array<[string, string, string]> = [
    ['RBC',              '003', 'RBC Royal Bank'],
    ['TD Canada Trust',  '004', 'TD Canada Trust'],
    ['BMO',              '001', 'BMO Bank of Montreal'],
    ['Scotiabank',       '002', 'Scotiabank'],
    ['CIBC',             '010', 'CIBC'],
    ['Equitable Bank',   '623', 'Equitable Bank'],
    ['EQ Bank',          '623', 'EQ Bank']
  ]

  it.each(cases)('%s → %s', (raw, expected) => {
    const b = lookupBank(raw)
    expect(b).not.toBeNull()
    expect(b!.institutionNo).toBe(expected)
  })

  it('unknown bank returns null (caller must HARD FAIL)', () => {
    expect(lookupBank('Bank of Zamunda')).toBeNull()
  })
})
