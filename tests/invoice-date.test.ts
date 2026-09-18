import { describe, it, expect } from 'vitest'
import { invoiceDateFor } from '../lib/deadline'

const sept = new Date('2026-09-01T00:00:00Z')
const readable = (d: Date) =>
  d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

describe('the date printed on an invoice', () => {
  it('is the 15th when nothing changed after the deadline', () => {
    // The whole month gets one date. Before this, an invoice said the day that BAM's
    // last receipt happened to be approved: the 56 live September invoices carried six
    // different dates between September 5th and the 16th.
    for (const changedOn of ['2026-09-02T16:12:00Z', '2026-09-09T20:00:00Z', '2026-09-15T07:59:00Z']) {
      expect(readable(invoiceDateFor(sept, new Date(changedOn)))).toBe('September 15, 2026')
    }
  })

  it('moves to the correction date when the invoice changed after the 15th', () => {
    expect(readable(invoiceDateFor(sept, new Date('2026-09-18T14:30:00Z')))).toBe('September 18, 2026')
  })

  it('never prints a date earlier than the deadline', () => {
    const early = invoiceDateFor(sept, new Date('2026-08-20T00:00:00Z'))
    expect(early.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-09-15T00:00:00Z'))
  })

  it('uses the month being invoiced, not the month it is run in', () => {
    // An October invoice corrected in November says November; one generated in
    // October says October 15th.
    const oct = new Date('2026-10-01T00:00:00Z')
    expect(readable(invoiceDateFor(oct, new Date('2026-10-03T00:00:00Z')))).toBe('October 15, 2026')
    expect(readable(invoiceDateFor(oct, new Date('2026-11-02T00:00:00Z')))).toBe('November 2, 2026')
  })

  it('sits at midday so a UTC render cannot land on the wrong day', () => {
    expect(invoiceDateFor(sept, new Date('2026-09-01T00:00:00Z')).getUTCHours()).toBe(12)
  })
})
