import { describe, it, expect } from 'vitest'
import { invoiceDateFor } from '../lib/deadline'

const sept = new Date('2026-09-01T00:00:00Z')
const oct = new Date('2026-10-01T00:00:00Z')
const readable = (d: Date) =>
  d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

describe('the date printed on an invoice', () => {
  it('is the 15th for every rebuild before the invoice is published', () => {
    // The whole month gets one date. Before this it said whatever day that BAM's last
    // receipt happened to be approved: the 56 live September invoices carried six
    // different dates between September 5th and the 16th.
    for (const on of ['2026-09-02T16:12:00Z', '2026-09-09T20:00:00Z', '2026-09-15T07:59:00Z']) {
      expect(readable(invoiceDateFor(sept, new Date(on), null))).toBe('September 15, 2026')
    }
  })

  it('survives the 16th and the 17th, which is where the first version failed', () => {
    // The audit cron runs on the 16th, generate on the 17th, and Robin decides flagged
    // receipts on the 16th. Every one of those rebuilds the payload. A rule of "the later
    // of the 15th and now" would have printed the 16th or 17th on nearly every invoice.
    expect(readable(invoiceDateFor(oct, new Date('2026-10-16T13:00:00Z'), null))).toBe('October 15, 2026')
    expect(readable(invoiceDateFor(oct, new Date('2026-10-17T13:00:00Z'), null))).toBe('October 15, 2026')
  })

  it('takes the date of a change made after the invoice was published', () => {
    // Noah Cardinal and Danica Ryan, 2026-09-18: released on the 17th, address corrected
    // on the 18th. Those two should say the 18th, not claim to be three days older.
    const released = new Date('2026-09-17T13:12:49Z')
    expect(readable(invoiceDateFor(sept, new Date('2026-09-18T14:30:00Z'), released)))
      .toBe('September 18, 2026')
  })

  it('stays on the 15th when a published invoice is rebuilt without changing', () => {
    const released = new Date('2026-10-17T13:00:00Z')
    expect(readable(invoiceDateFor(oct, new Date('2026-10-17T12:00:00Z'), released))).toBe('October 15, 2026')
  })

  it('uses the month being invoiced, not the month it runs in', () => {
    expect(readable(invoiceDateFor(oct, new Date('2026-10-03T00:00:00Z'), null))).toBe('October 15, 2026')
    expect(readable(invoiceDateFor(oct, new Date('2026-11-02T00:00:00Z'), null))).toBe('October 15, 2026')
  })

  it('sits at midday so a UTC render cannot land on the wrong day', () => {
    expect(invoiceDateFor(sept, new Date('2026-09-01T00:00:00Z'), null).getUTCHours()).toBe(12)
  })
})
