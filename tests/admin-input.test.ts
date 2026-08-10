/**
 * Rules that three admin write paths depend on, none of which had a test:
 *
 *  - parseAmount: POST /api/admin/cohorts refuses to create a cohort without a
 *    salary (the column is NOT NULL with no default). The create form never sent
 *    it, so every create 400'd and the page rendered the failure in green.
 *  - parseBankName: bank_name is the input to the institution-code lookup that
 *    routes payment. The roster edit form displayed it as saved while never
 *    sending it; now it is sent, and an unmapped name must hard-fail rather than
 *    sit in the column.
 *  - parseSchoolId: the roster table renders an empty school as a dash and used
 *    to send that placeholder straight back, writing the glyph into the column.
 */
import { describe, it, expect } from 'vitest'
import { parseAmount, parseBankName, parseSchoolId, parseCohortId, isUuid } from '../lib/admin-input'

describe('parseAmount (cohort salary)', () => {
  it('accepts the two confirmed salaries', () => {
    expect(parseAmount(218.75)).toEqual({ ok: true, value: 218.75 })
    expect(parseAmount('218.75')).toEqual({ ok: true, value: 218.75 })
    expect(parseAmount(250)).toEqual({ ok: true, value: 250 })
  })

  it('refuses a missing salary, which is the bug that broke cohort creation', () => {
    expect(parseAmount(undefined).ok).toBe(false)
    expect(parseAmount(null).ok).toBe(false)
    expect(parseAmount('').ok).toBe(false)
    expect(parseAmount('   ').ok).toBe(false)
  })

  it('refuses zero, negative and non-numeric', () => {
    expect(parseAmount(0).ok).toBe(false)
    expect(parseAmount(-5).ok).toBe(false)
    expect(parseAmount('abc').ok).toBe(false)
    expect(parseAmount(NaN).ok).toBe(false)
    expect(parseAmount({}).ok).toBe(false)
  })

  it('refuses an implausible amount instead of paying it', () => {
    expect(parseAmount(100001).ok).toBe(false)
  })

  it('rounds to cents', () => {
    expect(parseAmount('218.756')).toEqual({ ok: true, value: 218.76 })
  })

  it('carries no em dash in its error text', () => {
    const r = parseAmount(1e9)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toContain('—')
  })
})

describe('parseBankName', () => {
  it('stores the canonical display name so the later lookup cannot miss', () => {
    expect(parseBankName('rbc')).toEqual({ ok: true, value: 'RBC Royal Bank' })
    expect(parseBankName('Toronto-Dominion')).toEqual({ ok: true, value: 'TD Canada Trust' })
  })

  it('REFUSES a bank that has no institution number', () => {
    const r = parseBankName('Bank of Somewhere')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('not in the bank lookup')
  })

  it('refuses a name that only looks like a listed bank', () => {
    // P1-28: substring matching once routed "Unity Credit Union" to UNI (865).
    expect(parseBankName('Unity Credit Union').ok).toBe(false)
  })

  it('treats blank and the empty-cell dash as no bank', () => {
    expect(parseBankName('')).toEqual({ ok: true, value: null })
    expect(parseBankName(null)).toEqual({ ok: true, value: null })
    expect(parseBankName(undefined)).toEqual({ ok: true, value: null })
    expect(parseBankName('—')).toEqual({ ok: true, value: null })
    expect(parseBankName('--')).toEqual({ ok: true, value: null })
  })

  it('refuses a non-string', () => {
    expect(parseBankName(42).ok).toBe(false)
  })
})

describe('parseSchoolId', () => {
  it('maps every dash placeholder to null instead of storing the glyph', () => {
    for (const dash of ['-', '--', '–', '—', '−']) {
      expect(parseSchoolId(dash)).toEqual({ ok: true, value: null })
    }
  })

  it('keeps a real school name and strips invisible characters', () => {
    expect(parseSchoolId('  U of Toronto ')).toEqual({ ok: true, value: 'U of Toronto' })
    // Built from the code point, not typed as a literal: an invisible character
    // pasted into a source file cannot be reviewed, and a test that lost it would
    // pass while asserting nothing (see the SPACE_CODEPOINTS note in sanitize.ts).
    const zeroWidth = String.fromCodePoint(0x200b)
    expect(parseSchoolId(`Queen${zeroWidth}s U`)).toEqual({ ok: true, value: 'Queens U' })
    const bom = String.fromCodePoint(0xfeff)
    expect(parseSchoolId(`${bom}Western`)).toEqual({ ok: true, value: 'Western' })
  })

  it('treats blank as null and refuses an over-long value', () => {
    expect(parseSchoolId('')).toEqual({ ok: true, value: null })
    expect(parseSchoolId('x'.repeat(121)).ok).toBe(false)
  })
})

describe('parseCohortId', () => {
  it('accepts a uuid and lowercases it', () => {
    const r = parseCohortId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')
    expect(r).toEqual({ ok: true, value: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
  })

  it('refuses a blank cohort loudly (bams.cohort_id is NOT NULL)', () => {
    expect(parseCohortId('').ok).toBe(false)
    expect(parseCohortId(undefined).ok).toBe(false)
  })

  it('refuses a cohort NAME, which is what the roster page used to send', () => {
    expect(parseCohortId('Fall 2026').ok).toBe(false)
  })

  it('isUuid does not accept a near-miss', () => {
    expect(isUuid('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa')).toBe(false)
    expect(isUuid('dummy-0')).toBe(false)
  })
})
