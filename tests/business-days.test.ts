import { describe, it, expect } from 'vitest'
import { isWeekend, nextBusinessDay, sendEligibleAt } from '../lib/business-days'

describe('business days', () => {
  it('knows the weekend in UTC', () => {
    expect(isWeekend(new Date('2026-09-19T12:00:00Z'))).toBe(true)  // Saturday
    expect(isWeekend(new Date('2026-09-20T12:00:00Z'))).toBe(true)  // Sunday
    expect(isWeekend(new Date('2026-09-18T12:00:00Z'))).toBe(false) // Friday
  })

  it('leaves a business day alone', () => {
    const wed = new Date('2026-09-16T13:00:00Z')
    expect(nextBusinessDay(wed).toISOString()).toBe(wed.toISOString())
  })

  it('moves a weekend to Monday and keeps the time of day', () => {
    const sat = new Date('2026-09-19T13:00:00Z')
    const moved = nextBusinessDay(sat)
    expect(moved.getUTCDay()).toBe(1)
    expect(moved.toISOString()).toBe('2026-09-21T13:00:00.000Z')
  })

  it('does not modify the date it was given', () => {
    const sat = new Date('2026-09-19T13:00:00Z')
    nextBusinessDay(sat)
    expect(sat.toISOString()).toBe('2026-09-19T13:00:00.000Z')
  })

  it('a weekday release is eligible exactly 24 hours later', () => {
    // Released Wednesday 13:00, eligible Thursday 13:00.
    expect(sendEligibleAt(new Date('2026-09-16T13:00:00Z')).toISOString())
      .toBe('2026-09-17T13:00:00.000Z')
  })

  it('a Friday release lands on the weekend and opens at 00:00 Monday Toronto', () => {
    // Released Friday 13:00 UTC; 24h later is Saturday, so it opens Monday 00:00 EDT (04:00Z).
    expect(sendEligibleAt(new Date('2026-09-18T13:00:00Z')).toISOString())
      .toBe('2026-09-21T04:00:00.000Z')
  })

  it('the real October case: released Fri 2026-10-16 17:52 Toronto, open by Monday morning', () => {
    const e = sendEligibleAt(new Date('2026-10-16T21:52:00Z'))
    expect(e.toISOString()).toBe('2026-10-19T04:00:00.000Z')
    expect(e.getTime()).toBeLessThan(Date.parse('2026-10-19T12:00:00Z'))
  })

  it('a Sunday end opens Monday 00:00, and standard time (after Nov 1) is UTC-5', () => {
    // Released Saturday 2026-10-31 15:00Z, ends Sunday 11-01 15:00Z -> Monday 11-02 00:00 EST.
    expect(sendEligibleAt(new Date('2026-10-31T15:00:00Z')).toISOString())
      .toBe('2026-11-02T05:00:00.000Z')
  })

  it('a Friday-evening Toronto release that is already Saturday in UTC is still a weekday end', () => {
    // Thursday 20:00 Toronto = Friday 00:00Z; ends Friday 20:00 Toronto, a weekday, so exactly +24h.
    expect(sendEligibleAt(new Date('2026-10-16T00:00:00Z')).toISOString())
      .toBe('2026-10-17T00:00:00.000Z')
  })

  it('the weekend never shortens the window', () => {
    const released = new Date('2026-09-18T13:00:00Z')
    expect(sendEligibleAt(released).getTime() - released.getTime())
      .toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
  })
})
