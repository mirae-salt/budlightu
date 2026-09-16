import { describe, it, expect } from 'vitest'
import { windowStartedAt, sendEligibleAt } from '../lib/business-days'

/**
 * The rule the "Send to accounts payable" button counts with, as a function.
 *
 * It lived only inside a .filter() on /admin/invoices, written as one &&-ed expression
 * with a `sendEligibleAt(start!)` computed before the null check could short-circuit it.
 * The `!` satisfied the type checker, `null.getTime()` threw in the browser, and the
 * whole page went down the moment anyone selected an unreleased draft in a live cohort.
 * Nothing could catch that, because nothing could call it.
 */
export type SendableInput = {
  released_at: string | null
  accepted_at: string | null
  sendMode: string | null
  hasOpenQuestion: boolean
}

export function isSendable(inv: SendableInput, now = Date.now()): boolean {
  const start = windowStartedAt(inv.released_at)
  if (!start) return false
  if (inv.hasOpenQuestion) return false
  if (inv.accepted_at) return true
  return inv.sendMode !== 'live' || now >= sendEligibleAt(start).getTime()
}

const released = '2026-09-16T13:00:00Z'
const dayLater = Date.parse('2026-09-17T13:00:00Z')
const anHourLater = Date.parse('2026-09-16T14:00:00Z')

describe('which invoices the AP button will actually send', () => {
  it('an unreleased draft is not sendable, and asking does not throw', () => {
    expect(() => isSendable({ released_at: null, accepted_at: null, sendMode: 'live', hasOpenQuestion: false }))
      .not.toThrow()
    expect(isSendable({ released_at: null, accepted_at: null, sendMode: 'live', hasOpenQuestion: false })).toBe(false)
  })

  it('an open question blocks it however long it has been', () => {
    expect(isSendable({ released_at: released, accepted_at: null, sendMode: 'live', hasOpenQuestion: true }, dayLater))
      .toBe(false)
  })

  it('inside the window it waits, after the window it goes', () => {
    const inv = { released_at: released, accepted_at: null, sendMode: 'live', hasOpenQuestion: false }
    expect(isSendable(inv, anHourLater)).toBe(false)
    expect(isSendable(inv, dayLater)).toBe(true)
  })

  it('the BAM confirming clears it straight away', () => {
    expect(isSendable(
      { released_at: released, accepted_at: '2026-09-16T13:30:00Z', sendMode: 'live', hasOpenQuestion: false },
      anHourLater
    )).toBe(true)
  })

  it('a rehearsing cohort does not wait, but still has to be released', () => {
    expect(isSendable({ released_at: released, accepted_at: null, sendMode: 'dryrun', hasOpenQuestion: false }, anHourLater))
      .toBe(true)
    expect(isSendable({ released_at: null, accepted_at: null, sendMode: 'dryrun', hasOpenQuestion: false }, anHourLater))
      .toBe(false)
  })
})
