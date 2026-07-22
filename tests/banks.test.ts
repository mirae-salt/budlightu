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

  const cases: Array<[string, string]> = [
    ['RBC',                    '003'],
    ['TD Canada Trust',        '004'],
    ['BMO',                    '001'],
    ['Scotiabank',             '002'],
    ['CIBC',                   '010'],
    ['Desjardins',             '815'],
    ['Tangerine',              '614'],
    ['Simplii Financial',      '010'],
    ['National Bank',          '006'],
    ['ATB Financial',          '219'],
    ['Coast Capital Savings',  '809'],
    ['Vancity',                '809'],
    ['Wealthsimple',           '703'],
    ['Affinity Credit Union',  '839'],
    ['Conexus Credit Union',   '839'],
    ['Servus Credit Union',    '839'],
    ['Meridian Credit Union',  '839'],
  ]

  it.each(cases)('%s → %s', (raw, expected) => {
    const b = lookupBank(raw)
    expect(b).not.toBeNull()
    expect(b!.institutionNo).toBe(expected)
  })

  it('strips "credit union" and "financial" during normalization', () => {
    expect(normalizeBankName('Servus Credit Union')).toBe('servus')
    expect(normalizeBankName('Simplii Financial')).toBe('simplii')
    expect(normalizeBankName('Coast Capital Savings')).toBe('coast capital')
  })

  it('unknown bank returns null (caller must HARD FAIL)', () => {
    expect(lookupBank('Bank of Zamunda')).toBeNull()
  })
})
