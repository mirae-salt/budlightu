import { describe, it, expect } from 'vitest'
import { validatePeriod } from '../lib/period'

/**
 * A test account may submit for the CURRENT month even before the program opens,
 * so the flow can be exercised without moving a cohort's real start_date (which
 * then has to be remembered and reverted).
 */
describe('validatePeriod: test-account exception', () => {
  const cohort = { start_date: '2026-09-01', end_date: '2027-04-30' }
  const today = new Date('2026-08-10T12:00:00Z')

  it('a real student cannot submit for a month outside the program', () => {
    const r = validatePeriod('2026-08', cohort, today, { isTest: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/outside your program/i)
  })

  it('omitting the option is the same as not being a test account', () => {
    expect(validatePeriod('2026-08', cohort, today).ok).toBe(false)
  })

  it('a test account CAN submit for the current month', () => {
    const r = validatePeriod('2026-08', cohort, today, { isTest: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.period).toBe('2026-08-01')
  })

  it('the exception is the current month only: no future month', () => {
    const r = validatePeriod('2026-09', cohort, today, { isTest: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/future month/i)
  })

  it('the exception is the current month only: no backdating', () => {
    // July is a past month, so it is closed. The test exception covers the current
    // month only and does not reach back.
    const r = validatePeriod('2026-07', cohort, today, { isTest: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/July is closed/i)
  })

  it('a test account inside the program window behaves normally', () => {
    const inProgram = new Date('2026-10-05T12:00:00Z')
    expect(validatePeriod('2026-10', cohort, inProgram, { isTest: true }).ok).toBe(true)
    // September is closed by October: a test account gets the current-month exception,
    // not a way to reopen a month whose invoice has already gone out.
    expect(validatePeriod('2026-09', cohort, inProgram, { isTest: true }).ok).toBe(false)
    expect(validatePeriod('2027-05', cohort, inProgram, { isTest: true }).ok).toBe(false)
  })

  it('a test account CAN still submit after the deadline, so testing is never blocked', () => {
    // The whole point of the exception: exercising the flow must not depend on where we
    // are in the month. A real student is refused at the same instant (below).
    const afterDeadline = new Date('2026-10-16T08:00:00Z')
    expect(validatePeriod('2026-10', cohort, afterDeadline, { isTest: true }).ok).toBe(true)

    const r = validatePeriod('2026-10', cohort, afterDeadline, { isTest: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/closed on the 15th/i)
  })
})
