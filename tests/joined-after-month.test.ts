import { describe, it, expect } from 'vitest'
import { joinedAfterMonthEnded } from '../lib/joined-after-month'

describe('joinedAfterMonthEnded', () => {
  it('Hannah and Alivia joined Oct 5 and 6: nothing owed for September', () => {
    expect(joinedAfterMonthEnded('2026-10-06T13:41:18.855527+00:00', '2026-09-01')).toBe(true)
    expect(joinedAfterMonthEnded('2026-10-05T14:46:07.946662+00:00', '2026-09-01')).toBe(true)
  })
  it('Lea joined Sep 2: September is still hers to be invoiced for', () => {
    expect(joinedAfterMonthEnded('2026-09-02T15:00:00+00:00', '2026-09-01')).toBe(false)
  })
  it('the first instant of the next month counts as after; the last second of the month does not', () => {
    expect(joinedAfterMonthEnded('2026-10-01T00:00:00Z', '2026-09-01')).toBe(true)
    expect(joinedAfterMonthEnded('2026-09-30T23:59:59Z', '2026-09-01')).toBe(false)
  })
  it('works across a year boundary', () => {
    expect(joinedAfterMonthEnded('2027-01-03T00:00:00Z', '2026-12-01')).toBe(true)
  })
  it('an unknown join time keeps the student listed', () => {
    expect(joinedAfterMonthEnded(null, '2026-09-01')).toBe(false)
    expect(joinedAfterMonthEnded('not a date', '2026-09-01')).toBe(false)
  })
})
