import { describe, it, expect } from 'vitest'
import { windowStartedAt, sendEligibleAt } from '../lib/business-days'

/**
 * The 24-hour objection window (0035, 0036).
 *
 * It runs from publication and nothing restarts it. A correction after release changes
 * what the BAM's row says and sends them a notice, but the invoice is still due at the
 * same time: the send day is fixed, so corrections happen inside the first window rather
 * than moving the payment (Mirae, 2026-09-16).
 */
describe('the BAM objection window', () => {
  const released = '2026-09-16T13:00:00Z'

  it('runs from release', () => {
    expect(windowStartedAt(released)?.toISOString()).toBe('2026-09-16T13:00:00.000Z')
  })

  it('is null when the invoice was never released, which is the gate\'s cue to refuse', () => {
    expect(windowStartedAt(null)).toBeNull()
    expect(windowStartedAt(undefined)).toBeNull()
  })

  it('becomes sendable 24 hours later', () => {
    expect(sendEligibleAt(windowStartedAt(released)!).toISOString()).toBe('2026-09-17T13:00:00.000Z')
  })

  it('a Friday release waits for Monday, so the window can only ever get longer', () => {
    const friday = '2026-09-18T13:00:00Z'
    const eligible = sendEligibleAt(windowStartedAt(friday)!)
    expect(eligible.toISOString()).toBe('2026-09-21T13:00:00.000Z')
    expect(eligible.getTime() - Date.parse(friday)).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
  })
})
