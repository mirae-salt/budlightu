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
    // 2026-08-07: these four were all seeded 839 (Atlantic Central). None of them
    // clears through Atlantic Central. Canada has one central PER REGION.
    ['Affinity Credit Union',  '889'],   // Saskatchewan central
    ['Conexus Credit Union',   '889'],   // Saskatchewan central
    ['Servus Credit Union',    '899'],   // Alberta central
    ['Meridian Credit Union',  '837'],   // holds its OWN number, not a central
    ['Libro Credit Union',     '828'],   // Central 1 Ontario
    ['EQ Bank',                '623'],
    ['Laurentian Bank',        '039'],
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

  it('a bare "Caisse Populaire" no longer falls through to Desjardins', () => {
    // There are three unrelated caisse networks: Desjardins Quebec (815),
    // Desjardins Ontario (829) and Alliance (890), plus UNI/Acadienne (865).
    // A bare "caisse populaire" alias sent all of them to 815. Hard-failing sends
    // the student to a human instead of to the wrong clearing stream.
    expect(lookupBank('Caisse Populaire')).toBeNull()
  })

  it('no bank is left on 839 unless it genuinely clears through Atlantic Central', () => {
    // 839 is Atlantic Central (NS/NB/PE/NL). Seven credit unions from Ontario,
    // Alberta, Saskatchewan and Manitoba were seeded to it.
    const on839 = BANK_SEED.filter(b => b.institutionNo === '839').map(b => b.displayName)
    expect(on839).toEqual([])
  })

  it('dead institutions are absent, since a dead code routes into a closed lane', () => {
    // HSBC Canada (016) migrated to RBC in 2024; Canadian Western (030) to National
    // Bank in 2025; motusbank (374) into Meridian. An unlisted name hard-fails
    // safely and reaches a human, which is strictly better.
    for (const dead of ['016', '030', '374']) {
      expect(BANK_SEED.find(b => b.institutionNo === dead)).toBeUndefined()
    }
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
    expect(substringMatch?.institutionNo).toBe('865')   // UNI's number; the wrong bank for Unity CU
    expect(lookupBank('Unity Credit Union')).toBeNull() // the right answer now
  })

  it('other partial-name collisions also return null', () => {
    expect(lookupBank('Tangerine Dream Credit Union')).toBeNull()
    expect(lookupBank('TD Ameritrade Holdings')).toBeNull()
    expect(lookupBank('National Western Life')).toBeNull()
  })

  it('exact UNI still resolves, and to its OWN number not Desjardins', () => {
    // UNI is the former Caisse populaire acadienne (NB) at 865. It was seeded 815,
    // which is Desjardins Quebec — a live number, so the payment would have passed
    // every format check and entered the wrong clearing stream.
    expect(lookupBank('UNI Financial Cooperation')?.institutionNo).toBe('865')
    expect(lookupBank('UNI')?.institutionNo).toBe('865')
    expect(lookupBank('Caisse Populaire Acadienne')?.institutionNo).toBe('865')
  })

  it('the other caisses resolve to their own numbers, not Desjardins 815', () => {
    expect(lookupBank('Caisse Alliance')?.institutionNo).toBe('890')
    expect(lookupBank('Desjardins Ontario')?.institutionNo).toBe('829')
    expect(lookupBank('Desjardins')?.institutionNo).toBe('815')
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
      ['Alberta Treasury Branches',               '219'],
      ['Steinbach Credit Union',                  '879'],   // Manitoba central
      ['Connect First Credit Union',              '899'],   // Alberta central
      ['KOHO',                                    '621'],   // account is Peoples Trust
      ['Equitable Bank',                          '623'],
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

describe('every bank the dropdown offers survives the round trip', () => {
  // THE INVARIANT THAT WAS MISSING. Every bank <select> in the product uses
  // `displayName` as the option value, and the server then validates it with
  // lookupBank. Nothing checked that those two agreed, so four of the offered options
  // did not: three were refused outright ("not in our lookup. Please contact your
  // program manager", to a student who had picked from our own list), and Alterna Bank
  // silently resolved to Alterna Savings -- institution 842 for a bank whose number is
  // 608. A student's deposit block would have named one and routed to the other.
  //
  // It went unnoticed from July because the failing four are the entries whose
  // displayName is not simply their normalized form: parentheses, an apostrophe, or a
  // word normalizeBankName strips.
  it.each(BANK_SEED.map(b => [b.displayName, b.institutionNo] as const))(
    '%s resolves to %s',
    (displayName, institutionNo) => {
      const found = lookupBank(displayName)
      expect(found, `${displayName} is offered in the dropdown but lookupBank refuses it`).not.toBeNull()
      expect(found?.institutionNo).toBe(institutionNo)
    }
  )

  it('the four that used to fail, named so a regression is obvious', () => {
    expect(lookupBank('EQ Bank (Equitable Bank)')?.institutionNo).toBe('623')
    expect(lookupBank('SCU (Steinbach Credit Union)')?.institutionNo).toBe('879')
    expect(lookupBank("President's Choice Financial")?.institutionNo).toBe('320')
    // The dangerous one: an exact displayName must beat an alias pointing elsewhere.
    expect(lookupBank('Alterna Bank')?.institutionNo).toBe('608')
    expect(lookupBank('Alterna Savings')?.institutionNo).toBe('842')
  })

  it('the shorthand aliases still work', () => {
    // The displayName match is added in front of these, not instead of them.
    expect(lookupBank('eq')?.institutionNo).toBe('623')
    expect(lookupBank('equitable')?.institutionNo).toBe('623')
    expect(lookupBank('steinbach')?.institutionNo).toBe('879')
    expect(lookupBank('alterna')?.institutionNo).toBe('842')
    expect(lookupBank('td')?.institutionNo).toBe('004')
  })
})
