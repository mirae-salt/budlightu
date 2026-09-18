import { describe, it, expect } from 'vitest'
import { invoiceDateFor, INVOICE_DATE_DAY } from '../lib/deadline'

const readable = (d: Date) =>
  d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

describe('the date printed on an invoice', () => {
  it('is the 16th of the month being invoiced', () => {
    // Before this it said whatever day that BAM's last receipt happened to be approved.
    // The 56 live September invoices carried six different dates between the 5th and the
    // 16th, and the sixteen sent to AP in the same thirty seconds carried six of them.
    expect(readable(invoiceDateFor(new Date('2026-09-01T00:00:00Z')))).toBe('September 16, 2026')
    expect(readable(invoiceDateFor(new Date('2026-10-01T00:00:00Z')))).toBe('October 16, 2026')
    expect(readable(invoiceDateFor(new Date('2027-01-01T00:00:00Z')))).toBe('January 16, 2027')
  })

  it('depends on nothing but the period', () => {
    // The point of the rule. Two earlier versions took the rebuild time or the release
    // time as well, and both let one month's invoices end up carrying two dates: the
    // audit cron runs on the 16th and generate on the 17th, so "when this was last
    // rebuilt" is never the same answer twice.
    const sept = new Date('2026-09-01T00:00:00Z')
    expect(invoiceDateFor(sept).getTime()).toBe(invoiceDateFor(sept).getTime())
    expect(invoiceDateFor(new Date('2026-09-01T23:59:59Z')).getTime())
      .toBe(invoiceDateFor(sept).getTime())
  })

  it('is the audit day, not the receipt deadline', () => {
    // The 15th is the last day a student may submit. The 16th is when the audit runs and
    // Robin decides what it flagged, so it is the first day the total is actually true.
    expect(INVOICE_DATE_DAY).toBe(16)
  })

  it('sits at midday so a UTC render cannot land on the wrong day', () => {
    expect(invoiceDateFor(new Date('2026-09-01T00:00:00Z')).getUTCHours()).toBe(12)
  })
})
