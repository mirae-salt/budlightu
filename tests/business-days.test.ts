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

  it('a Friday release lands on the weekend and is pushed to Monday', () => {
    // Released Friday 13:00; 24h later is Saturday, so the send waits for Monday.
    expect(sendEligibleAt(new Date('2026-09-18T13:00:00Z')).toISOString())
      .toBe('2026-09-21T13:00:00.000Z')
  })

  it('the weekend never shortens the window', () => {
    const released = new Date('2026-09-18T13:00:00Z')
    expect(sendEligibleAt(released).getTime() - released.getTime())
      .toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
  })
})
