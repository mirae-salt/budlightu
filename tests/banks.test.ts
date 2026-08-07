import { describe, it, expect } from 'vitest'
import { normalizeBankName, lookupBank, BANK_SEED, BANK_ALIASES } from '../lib/banks'

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

describe('P1-28 · lookupBank is EXACT, never a substring match', () => {
  it('a credit union whose name contains "uni" is NOT matched to UNI Financial', () => {
    // The reported case. Substring matching returned 815 (UNI Financial), which
    // would have routed a direct deposit to the wrong institution.
    expect(lookupBank('Community Savings Credit Union')).toBeNull()
    expect(lookupBank('Unity Credit Union')).toBeNull()
    expect(lookupBank('University Credit Union')).toBeNull()
  })

  it('documents the old behaviour so this cannot regress unnoticed', () => {
    const substringMatch = BANK_SEED.find(b => normalizeBankName('Unity Credit Union').includes(b.normalized))
    expect(substringMatch?.institutionNo).toBe('815')   // the wrong answer it used to give
    expect(lookupBank('Unity Credit Union')).toBeNull() // the right answer now
  })

  it('other partial-name collisions also return null', () => {
    expect(lookupBank('Tangerine Dream Credit Union')).toBeNull()
    expect(lookupBank('TD Ameritrade Holdings')).toBeNull()
    expect(lookupBank('National Western Life')).toBeNull()
  })

  it('exact UNI still resolves', () => {
    expect(lookupBank('UNI Financial Cooperation')?.institutionNo).toBe('815')
    expect(lookupBank('UNI')?.institutionNo).toBe('815')
  })

  it('aliases cover the real spellings people type', () => {
    const cases: Array<[string, string]> = [
      ['Royal Bank of Canada',                    '003'],
      ['The Toronto-Dominion Bank',               '004'],
      ['Bank of Montreal',                        '001'],
      ['The Bank of Nova Scotia',                 '002'],
      ['Canadian Imperial Bank of Commerce',      '010'],
      ['National Bank of Canada',                 '006'],
      ['Banque Nationale',                        '006'],
      ['Caisse Populaire',                        '815'],
      ['Alberta Treasury Branches',               '219'],
      ['Steinbach Credit Union',                  '839'],
      ['Connect First Credit Union',              '839'],
    ]
    for (const [raw, expected] of cases) {
      const b = lookupBank(raw)
      expect(b, `expected ${raw} to resolve`).not.toBeNull()
      expect(b!.institutionNo, `${raw} institution number`).toBe(expected)
    }
  })

  it('every alias points at a real seed entry', () => {
    for (const [alias, target] of Object.entries(BANK_ALIASES)) {
      expect(BANK_SEED.some(b => b.normalized === target), `alias "${alias}" -> "${target}"`).toBe(true)
    }
  })

  it('an invisible character in the bank name does not break the lookup', () => {
    expect(lookupBank('\uFEFFRBC')?.institutionNo).toBe('003')
    expect(lookupBank('TD\u200B Canada Trust')?.institutionNo).toBe('004')
  })

  it('empty or non-string input returns null instead of throwing', () => {
    expect(lookupBank('')).toBeNull()
    expect(lookupBank('   ')).toBeNull()
    // @ts-expect-error deliberate misuse
    expect(lookupBank(undefined)).toBeNull()
  })
})
