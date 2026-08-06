import { describe, it, expect } from 'vitest'
import { baseInitials, resolveInitials } from '../lib/initials'

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

  it('falls back to numeric suffix on identical names', () => {
    const out = resolveInitials([
      { id: '1', firstName: 'Alex', lastName: 'Kim' },
      { id: '2', firstName: 'Alex', lastName: 'Kim' }
    ])
    const initials = new Map(out.map(o => [o.bamId, o.initials]))
    expect(initials.get('1')).toBe('AK1')
    expect(initials.get('2')).toBe('AK2')
  })

  it('preserves single-BAM cohorts (no collision)', () => {
    const out = resolveInitials([{ id: 'only', firstName: 'Kira', lastName: 'Sabharwal' }])
    expect(out).toEqual([{ bamId: 'only', initials: 'KS' }])
  })
})
