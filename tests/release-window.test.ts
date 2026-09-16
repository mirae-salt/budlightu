import { describe, it, expect } from 'vitest'
import { windowStartedAt, sendEligibleAt } from '../lib/business-days'

/**
 * The 24-hour objection window, and what a correction does to it (0035, 0036).
 *
 * A correction restarts the clock instead of un-publishing the invoice, so the hours
 * always run against the figure the BAM was last shown. These are the sums the send gate
 * in batch-approve and the line on /portal/invoices both do.
 */
describe('the BAM objection window', () => {
  const released = '2026-09-16T13:00:00Z'

  it('runs from release when nothing has changed', () => {
    expect(windowStartedAt(released, null)?.toISOString()).toBe('2026-09-16T13:00:00.000Z')
  })

  it('is null when the invoice was never released, which is the gate\'s cue to refuse', () => {
    expect(windowStartedAt(null, null)).toBeNull()
    expect(windowStartedAt(null, '2026-09-16T15:00:00Z')).toBeNull()
  })

  it('restarts from a correction made after release', () => {
    const revised = '2026-09-16T18:00:00Z'
    expect(windowStartedAt(released, revised)?.toISOString()).toBe('2026-09-16T18:00:00.000Z')
  })

  it('ignores a revision stamp older than the release, which belongs to a previous cycle', () => {
    const stale = '2026-09-15T09:00:00Z'
    expect(windowStartedAt(released, stale)?.toISOString()).toBe('2026-09-16T13:00:00.000Z')
  })

  it('a correction pushes the send out, it never pulls it in', () => {
    // Released 30 hours ago, so on its own this would already be sendable.
    const longAgo = new Date(Date.parse('2026-09-16T13:00:00Z') - 30 * 60 * 60 * 1000).toISOString()
    const justNow = '2026-09-16T12:00:00Z'
    const start = windowStartedAt(longAgo, justNow)!
    expect(sendEligibleAt(start).getTime()).toBeGreaterThan(sendEligibleAt(new Date(longAgo)).getTime())
  })

  it('an untouched invoice becomes sendable 24 hours later', () => {
    const start = windowStartedAt(released, null)!
    const eligible = sendEligibleAt(start)
    expect(eligible.toISOString()).toBe('2026-09-17T13:00:00.000Z')
    // A minute before, it is not.
    expect(eligible.getTime()).toBeGreaterThan(Date.parse('2026-09-17T12:59:00Z'))
  })
})
