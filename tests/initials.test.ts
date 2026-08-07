import { describe, it, expect } from 'vitest'
import { baseInitials, resolveInitials, isUsableInitials, type Bam } from '../lib/initials'
import { formatInvoiceNumber } from '../lib/invoice-numbering'

describe('baseInitials', () => {
  it('takes first letter of first + last name', () => {
    expect(baseInitials({ firstName: 'Lucas', lastName: 'Grabowski' })).toBe('LG')
    expect(baseInitials({ firstName: 'Reese', lastName: 'Garcia' })).toBe('RG')
  })
  it('is uppercased', () => {
    expect(baseInitials({ firstName: 'sara', lastName: 'lee' })).toBe('SL')
  })
})

describe('resolveInitials — P0-1 fix', () => {
  it('no collision → base initials', () => {
    const out = resolveInitials([
      { id: '1', firstName: 'Reese', lastName: 'Garcia' },
      { id: '2', firstName: 'Jamie', lastName: 'Green' }
    ])
    expect(new Set(out.map(o => o.initials))).toEqual(new Set(['RG', 'JG']))
  })

  it('LG collision (real Lucas + Luke case) — algorithm escalates until unique', () => {
    const out = resolveInitials([
      { id: 'lucas', firstName: 'Lucas', lastName: 'Grabowski' },
      { id: 'luke',  firstName: 'Luke',  lastName: 'Grabowski' }
    ])
    const initials = new Map(out.map(o => [o.bamId, o.initials]))
    // Uniqueness is the load-bearing property; exact escalation depth is
    // implementation detail. Both LGR (step 1) and LUGR (step 2) collide
    // because both first names begin with LU/L — so it escalates to step 3
    // (first-3-letters of first + first-2-of last): LUCGR / LUKGR.
    expect(initials.get('lucas')).not.toBe(initials.get('luke'))
    expect(initials.get('lucas')).toBe('LUCGR')
    expect(initials.get('luke')).toBe('LUKGR')
  })

  it('two-BAM collision produces two distinct initials strings', () => {
    const out = resolveInitials([
      { id: 'lucas', firstName: 'Lucas', lastName: 'Grabowski' },
      { id: 'luke',  firstName: 'Luke',  lastName: 'Grabowski' }
    ])
    expect(new Set(out.map(o => o.initials)).size).toBe(2)
  })

  it('three-way collision escalates further', () => {
    const out = resolveInitials([
      { id: 'a', firstName: 'Aaron',   lastName: 'Anderson' },
      { id: 'b', firstName: 'Alice',   lastName: 'Anderson' },
      { id: 'c', firstName: 'Adam',    lastName: 'Anderson' }
    ])
    expect(new Set(out.map(o => o.initials)).size).toBe(3)
  })

  /**
   * P1-7: this test used to expect 'AK1' / 'AK2'. That fallback was invalid, not
   * merely ugly: formatInvoiceNumber validates initials against /^[A-Z]{2,10}$/,
   * so a digit suffix threw and the documented "identical names" path could
   * never actually produce an invoice. The fallback is letters now.
   */
  it('falls back to a LETTER suffix on identical names (digits are rejected downstream)', () => {
    const out = resolveInitials([
      { id: '1', firstName: 'Alex', lastName: 'Kim' },
      { id: '2', firstName: 'Alex', lastName: 'Kim' }
    ])
    const initials = new Map(out.map(o => [o.bamId, o.initials]))
    expect(initials.get('1')).toBe('AKA')
    expect(initials.get('2')).toBe('AKB')
  })

  it('preserves single-BAM cohorts (no collision)', () => {
    const out = resolveInitials([{ id: 'only', firstName: 'Kira', lastName: 'Sabharwal' }])
    expect(out).toEqual([{ bamId: 'only', initials: 'KS' }])
  })
})

/**
 * The load-bearing contract: nothing resolveInitials can return may make
 * formatInvoiceNumber throw. A throw inside scheduler-generate used to abort the
 * whole monthly run, so one unusable roster row meant nobody got an invoice.
 */
describe('every resolveInitials output satisfies formatInvoiceNumber (P1-7/P1-8)', () => {
  const rosters: Array<{ label: string; bams: Bam[] }> = [
    {
      label: 'identical names (letter-suffix fallback)',
      bams: [
        { id: '1', firstName: 'Alex', lastName: 'Kim' },
        { id: '2', firstName: 'Alex', lastName: 'Kim' },
        { id: '3', firstName: 'Alex', lastName: 'Kim' }
      ]
    },
    {
      label: 'accents and non-Latin scripts',
      bams: [
        { id: 'a', firstName: 'Émile', lastName: 'Côté' },
        { id: 'b', firstName: 'Michał', lastName: 'Nowak' },
        { id: 'c', firstName: '李', lastName: '王' },
        { id: 'd', firstName: 'Владимир', lastName: 'Петров' }
      ]
    },
    {
      label: 'mononyms and empty name parts',
      bams: [
        { id: 'm1', firstName: 'Ana', lastName: '' },
        { id: 'm2', firstName: '', lastName: '' },
        { id: 'm3', firstName: 'Ali', lastName: 'Ó' }
      ]
    },
    {
      label: 'the real Lucas/Luke Grabowski collision',
      bams: [
        { id: 'lucas', firstName: 'Lucas', lastName: 'Grabowski' },
        { id: 'luke', firstName: 'Luke', lastName: 'Grabowski' }
      ]
    },
    {
      label: '26+ identical names (letter suffix must roll over past Z)',
      bams: Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, firstName: 'Sam', lastName: 'Lee' }))
    }
  ]

  for (const { label, bams } of rosters) {
    it(`${label}: every value is usable and unique`, () => {
      const out = resolveInitials(bams)
      expect(out.length).toBe(bams.length)
      for (const r of out) {
        expect(isUsableInitials(r.initials), `${r.bamId} -> ${r.initials}`).toBe(true)
        // The real gate: this is what scheduler-generate calls.
        expect(() => formatInvoiceNumber(r.initials, 1), `${r.bamId} -> ${r.initials}`).not.toThrow()
        expect(formatInvoiceNumber(r.initials, 1)).toBe(`INV-${r.initials}1`)
      }
      expect(new Set(out.map(o => o.initials)).size).toBe(bams.length)
    })
  }

  it('rejects the old digit-suffix fallback, which is why it had to change', () => {
    expect(isUsableInitials('AK1')).toBe(false)
    expect(() => formatInvoiceNumber('AK1', 1)).toThrow()
  })
})
