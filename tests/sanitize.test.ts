/**
 * P1-6 / P1-18 / P1-26 / P1-27 regression suite.
 * The BOM incident class: invisible characters that change bytes without
 * changing how a value looks.
 */
import { describe, it, expect } from 'vitest'
import {
  stripInvisible, cleanText, normalizeEmail, isValidEmail, parseEmail,
  envAddress, envAddressList, envString, slugifySegment,
  cleanEnvValue, cleanAddress, isEmailAddress, addressProblem,
  envAddressOr, envAddressListOr, envToken, tokenProblem, sanitizePoNumber
} from '../lib/sanitize'
import { stripInvisible as reExported, envAddress as envAddressReExported } from '../lib/app-url'
import * as envClean from '../lib/env-clean'

const BOM = '\uFEFF'
const ZWSP = '\u200B'
const NBSP = '\u00A0'

describe('stripInvisible', () => {
  it('removes the BOM that caused the incident', () => {
    expect(stripInvisible(`${BOM}https://budlightu.com`)).toBe('https://budlightu.com')
  })

  it('removes zero-width space, which trim() does NOT', () => {
    expect(`${ZWSP}a`.trim()).toBe(`${ZWSP}a`)   // proof that trim is not enough
    expect(stripInvisible(`${ZWSP}a${ZWSP}`)).toBe('a')
  })

  it('removes bidi marks, word joiner, soft hyphen and control characters', () => {
    expect(stripInvisible('a\u200Eb\u2060c\u00ADde')).toBe('abcde')
  })

  it('leaves ordinary and accented text alone', () => {
    expect(stripInvisible('Emile Cote')).toBe('Emile Cote')
    expect(stripInvisible('\u00C9mile')).toBe('\u00C9mile')
  })

  it('is re-exported from lib/app-url for the AP send path', () => {
    expect(reExported).toBe(stripInvisible)
    expect(envAddressReExported).toBe(envAddress)
  })
})

describe('cleanText', () => {
  it('folds NBSP to a plain space and collapses runs', () => {
    expect(cleanText(`Lucas${NBSP}${NBSP}Grabowski`)).toBe('Lucas Grabowski')
  })
  it('trims and strips invisibles', () => {
    expect(cleanText(`  ${BOM}Fall 2026 ${ZWSP} `)).toBe('Fall 2026')
  })
  it('returns empty string for non-strings instead of throwing', () => {
    expect(cleanText(undefined)).toBe('')
    expect(cleanText(null)).toBe('')
    expect(cleanText(42)).toBe('')
  })
})

describe('P1-6 · normalizeEmail (the write path must match the read path)', () => {
  it('lowercases, which is what the read path assumed', () => {
    expect(normalizeEmail('Lucas.Grabowski@uwo.ca')).toBe('lucas.grabowski@uwo.ca')
  })

  it('removes a trailing space, the case that actually locked a BAM out', () => {
    expect(normalizeEmail('lucas.grabowski@uwo.ca ')).toBe('lucas.grabowski@uwo.ca')
  })

  it('removes invisible characters that trim() misses', () => {
    expect(normalizeEmail(`${ZWSP}lucas@uwo.ca`)).toBe('lucas@uwo.ca')
    expect(normalizeEmail(`${BOM}lucas@uwo.ca${NBSP}`)).toBe('lucas@uwo.ca')
  })

  it('is idempotent, so a repeated save cannot drift', () => {
    const once = normalizeEmail(' Lucas.Grabowski@UWO.ca ')
    expect(normalizeEmail(once)).toBe(once)
  })

  it('agrees with the old read-path normalizer on clean input', () => {
    const raw = '  Robin.Graham@ilovesalt.com  '
    expect(normalizeEmail(raw)).toBe(raw.trim().toLowerCase())
  })

  it('returns empty string for non-strings', () => {
    expect(normalizeEmail(undefined)).toBe('')
    expect(normalizeEmail(null)).toBe('')
  })
})

describe('isValidEmail / parseEmail fail closed', () => {
  it.each([
    'lucas@uwo.ca',
    'first.last+tag@sub.domain.co.uk',
    'a@b.ca'
  ])('accepts %s', e => expect(isValidEmail(e)).toBe(true))

  it.each([
    '',
    'nope',
    'no@domain',
    '@uwo.ca',
    'a b@uwo.ca',
    'a@@uwo.ca',
    'a@uwo..ca',
    'a@-uwo.ca'
  ])('rejects %j', e => expect(isValidEmail(e)).toBe(false))

  it('parseEmail returns the normalized value on success', () => {
    expect(parseEmail(' Lucas@UWO.ca ')).toEqual({ ok: true, email: 'lucas@uwo.ca' })
  })

  it('parseEmail refuses rather than falling back to the raw value', () => {
    const r = parseEmail('Lucas Grabowski')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('not a valid email')
  })
})

describe('P1-18 · envAddress', () => {
  const env = {
    CLEAN: 'accounts.payable@ilovesalt.com',
    WITH_BOM: `${BOM}accounts.payable@ilovesalt.com`,
    WITH_SPACE: ' accounts.payable@ilovesalt.com\n',
    UPPER: 'Accounts.Payable@ILoveSalt.com',
    GARBAGE: 'not an address',
    EMPTY: '',
    LIST: 'jenna@ilovesalt.com, robin@ilovesalt.com ;bad@@x',
    HOST: `${BOM} ilovesalt.sharepoint.com `
  }

  it('strips a BOM that would become %EF%BB%BF in a Graph URL', () => {
    expect(envAddress('WITH_BOM', env)).toBe('accounts.payable@ilovesalt.com')
    // Proof of the failure mode being prevented:
    expect(encodeURIComponent(env.WITH_BOM)).toContain('%EF%BB%BF')
    expect(encodeURIComponent(envAddress('WITH_BOM', env)!)).not.toContain('%EF%BB%BF')
  })

  it('trims and lowercases', () => {
    expect(envAddress('WITH_SPACE', env)).toBe('accounts.payable@ilovesalt.com')
    expect(envAddress('UPPER', env)).toBe('accounts.payable@ilovesalt.com')
  })

  it('returns null for missing, empty or unusable values so callers fail closed', () => {
    expect(envAddress('MISSING', env)).toBeNull()
    expect(envAddress('EMPTY', env)).toBeNull()
    expect(envAddress('GARBAGE', env)).toBeNull()
  })

  it('envAddressList drops unusable entries and keeps the rest', () => {
    expect(envAddressList('LIST', env)).toEqual(['jenna@ilovesalt.com', 'robin@ilovesalt.com'])
    expect(envAddressList('MISSING', env)).toEqual([])
  })

  it('envString cleans non-email values such as a tenant id or host', () => {
    expect(envString('HOST', env)).toBe('ilovesalt.sharepoint.com')
    expect(envString('EMPTY', env)).toBeNull()
    expect(envString('MISSING', env)).toBeNull()
  })
})

describe('P1-27 · slugifySegment (SharePoint archive folder)', () => {
  it('an invisible character does not create a second identical-looking folder', () => {
    const clean = slugifySegment('Fall 2026')
    const poisoned = slugifySegment(`Fall${BOM} 2026`)
    const poisoned2 = slugifySegment(`Fall ${ZWSP}2026`)
    expect(clean).toBe('Fall-2026')
    expect(poisoned).toBe(clean)
    expect(poisoned2).toBe(clean)
  })

  it('the old implementation really did split the audit trail', () => {
    // JavaScript's \s DOES match U+FEFF, so the old
    // `cohort.name.replace(/\s+/g, '-')` turned a leading or trailing BOM into a
    // literal hyphen. That is a different folder name that renders identically:
    // "-Fall-2026" next to "Fall-2026". A BOM prepended to a value is exactly
    // the shape of the 2026-08-07 incident.
    const oldWay = (s: string) => s.replace(/\s+/g, '-')
    expect(oldWay(`${BOM}Fall 2026`)).toBe('-Fall-2026')
    expect(oldWay(`${BOM}Fall 2026`)).not.toBe(oldWay('Fall 2026'))
    expect(oldWay(`Fall 2026${BOM}`)).toBe('Fall-2026-')

    // The replacement collapses all three to one folder.
    expect(slugifySegment(`${BOM}Fall 2026`)).toBe('Fall-2026')
    expect(slugifySegment(`Fall 2026${BOM}`)).toBe('Fall-2026')
    expect(slugifySegment('Fall 2026')).toBe('Fall-2026')
  })

  it('folds characters SharePoint rejects', () => {
    expect(slugifySegment('Summer/Fall: 2026?')).toBe('Summer-Fall-2026')
  })

  it('returns empty string when there is nothing usable, so the caller can refuse', () => {
    expect(slugifySegment(`${BOM}${ZWSP}  `)).toBe('')
  })
})


/**
 * Task 5 consolidation guard.
 *
 * `lib/env-clean.ts` used to carry a SECOND, independently written copy of the
 * invisible-character stripper. Two copies means one drifts and a BOM slips
 * through the other, so it is now a re-export of this module. These assert
 * IDENTITY (same function object), not similar behaviour, because "looks the
 * same" is exactly what the audit caught.
 */
describe('one implementation only (lib/env-clean is a re-export)', () => {
  it('every env-clean export is the same function object as the sanitize one', () => {
    expect(envClean.stripInvisible).toBe(stripInvisible)
    expect(envClean.cleanEnvValue).toBe(cleanEnvValue)
    expect(envClean.cleanAddress).toBe(cleanAddress)
    expect(envClean.isEmailAddress).toBe(isEmailAddress)
    expect(envClean.addressProblem).toBe(addressProblem)
    expect(envClean.envAddressOr).toBe(envAddressOr)
    expect(envClean.envAddressListOr).toBe(envAddressListOr)
    expect(envClean.envToken).toBe(envToken)
    expect(envClean.tokenProblem).toBe(tokenProblem)
    expect(envClean.sanitizePoNumber).toBe(sanitizePoNumber)
  })

  /**
   * The invisible-character set is spelled with NUMERIC code points, never with
   * backslash-u escapes inside a regex literal: an earlier attempt had those
   * escapes collapse into the literal characters when the file was written, so
   * the character class matched nothing while reading correctly on screen.
   * Behaviour is asserted here, never the source text.
   */
  it('strips every code point it claims to, by behaviour not by reading the source', () => {
    const cases: Array<[number, string]> = [
      [0xfeff, 'BOM'],
      [0x200b, 'zero-width space'],
      [0x200d, 'zero-width joiner'],
      [0x200e, 'LTR mark'],
      [0x202e, 'RTL override'],
      [0x2060, 'word joiner'],
      [0x2066, 'LTR isolate'],
      [0x2069, 'pop directional isolate'],
      [0x00ad, 'soft hyphen'],
      [0x0009, 'tab'],
      [0x000a, 'newline'],
      [0x007f, 'DEL'],
      [0x0085, 'C1 NEL']
    ]
    for (const [cp, label] of cases) {
      const ch = String.fromCodePoint(cp)
      expect(stripInvisible(`a${ch}b`), `${label} (U+${cp.toString(16)})`).toBe('ab')
    }
  })

  it('folds every space-separator code point to a plain space', () => {
    const spaceLike = [0x00a0, 0x1680, 0x2000, 0x2005, 0x200a, 0x202f, 0x205f, 0x3000]
    for (const cp of spaceLike) {
      const ch = String.fromCodePoint(cp)
      expect(cleanText(`a${ch}b`), `cleanText U+${cp.toString(16)}`).toBe('a b')
      expect(cleanEnvValue(`${ch}a${ch}`), `cleanEnvValue U+${cp.toString(16)}`).toBe('a')
    }
  })

  /**
   * Behaviour that got STRICTER when the two modules collapsed, deliberately.
   * env-clean's stripper DELETED an interior NBSP, which turned a corrupted
   * value into a plausible one: "a<NBSP>b@x.ca" became the perfectly valid
   * "ab@x.ca", and PO "260<NBSP>351" became an accepted "260351". It now folds
   * to a space, which every validator rejects, so a human retypes it.
   */
  it('does not silently repair a corrupted address or PO into a plausible one', () => {
    expect(cleanAddress(`a${NBSP}b@x.ca`)).toBe('a b@x.ca')
    expect(addressProblem('AP_EMAIL', cleanAddress(`a${NBSP}b@x.ca`))).toMatch(/valid single email/)
    expect(sanitizePoNumber(`260${NBSP}351`).ok).toBe(false)
    // Leading/trailing invisibles are still cleaned up: that is the common case.
    expect(addressProblem('AP_EMAIL', cleanAddress(`${BOM}ap@x.com${NBSP}`))).toBeNull()
    expect(sanitizePoNumber(`${BOM} 260351 `)).toEqual({ ok: true, value: '260351' })
  })

  it('rejects a URL-path token that carries an invisible character', () => {
    process.env.__TEST_TENANT = `${BOM}abc-123`
    expect(envToken('__TEST_TENANT')).toBe('abc-123')
    expect(tokenProblem('MS_TENANT_ID', envToken('__TEST_TENANT'))).toBeNull()
    process.env.__TEST_TENANT = `abc${NBSP}123`
    expect(tokenProblem('MS_TENANT_ID', envToken('__TEST_TENANT'))).toMatch(/unsafe in a URL path/)
    delete process.env.__TEST_TENANT
  })
})
