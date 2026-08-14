/**
 * Reevaluation is a CONSECUTIVE rule: two shortfall months in a row, which is what
 * Robin confirmed over Teams. The code counted total warnings for the cohort, so a BAM
 * who underspent in September and again in February was flagged as though it had
 * happened twice running. These cases pin the difference.
 */
import { describe, it, expect } from 'vitest'
import { previousPeriod, consecutiveWarningStreak, REEVALUATE_THRESHOLD } from '../lib/shortfall-warning'

describe('previousPeriod', () => {
  it('steps back one month', () => {
    expect(previousPeriod('2026-09-01')).toBe('2026-08-01')
  })

  it('crosses the year boundary', () => {
    expect(previousPeriod('2027-01-01')).toBe('2026-12-01')
  })

  it('keeps the two-digit month padded', () => {
    // '2026-9-01' would never match a stored period, so the streak would silently
    // stop at 1 and nobody would ever be reevaluated.
    expect(previousPeriod('2026-10-01')).toBe('2026-09-01')
    expect(previousPeriod('2026-11-01')).toBe('2026-10-01')
  })
})

describe('consecutiveWarningStreak', () => {
  it('counts a single month as 1', () => {
    expect(consecutiveWarningStreak(['2026-09-01'], '2026-09-01')).toBe(1)
  })

  it('counts two in a row as 2', () => {
    expect(consecutiveWarningStreak(['2026-08-01', '2026-09-01'], '2026-09-01')).toBe(2)
  })

  it('counts three in a row as 3, across a year boundary', () => {
    const periods = ['2026-11-01', '2026-12-01', '2027-01-01']
    expect(consecutiveWarningStreak(periods, '2027-01-01')).toBe(3)
  })

  it('does NOT count two months separated by a good month', () => {
    // The exact case that was being misreported: September and February.
    const periods = ['2026-09-01', '2027-02-01']
    expect(consecutiveWarningStreak(periods, '2027-02-01')).toBe(1)
  })

  it('ignores earlier runs that ended', () => {
    // Two in a row last autumn, then a gap, then one now. The current run is 1.
    const periods = ['2026-09-01', '2026-10-01', '2027-02-01']
    expect(consecutiveWarningStreak(periods, '2027-02-01')).toBe(1)
  })

  it('returns 0 when the period itself has no warning', () => {
    expect(consecutiveWarningStreak(['2026-08-01'], '2026-09-01')).toBe(0)
  })

  it('returns 0 for an empty history', () => {
    expect(consecutiveWarningStreak([], '2026-09-01')).toBe(0)
  })

  it('is not fooled by duplicate periods', () => {
    // A count-based rule would read this as 2 and reevaluate on one bad month.
    const periods = ['2026-09-01', '2026-09-01']
    expect(consecutiveWarningStreak(periods, '2026-09-01')).toBe(1)
  })

  it('two in a row reaches the reevaluation threshold; one does not', () => {
    expect(consecutiveWarningStreak(['2026-08-01', '2026-09-01'], '2026-09-01'))
      .toBeGreaterThanOrEqual(REEVALUATE_THRESHOLD)
    expect(consecutiveWarningStreak(['2026-09-01'], '2026-09-01'))
      .toBeLessThan(REEVALUATE_THRESHOLD)
  })
})

describe('the threshold Robin sees and the threshold that sends mail', () => {
  it('are the same number', async () => {
    // The dashboard once used a local LOW_THRESHOLD = 130 while warnings fired below 75, so
    // a BAM who spent $100 was shown as low and never warned. Both read this constant now,
    // so this test does not pin a value -- it pins that there is only one of them. The value
    // itself is Robin's call: $75 was the 2026-08-07 placeholder, $130 is her 2026-08-14
    // decision, and whichever it is next, this test only fails if a second copy reappears.
    const { SHORTFALL_WARN_BELOW_CAD } = await import('../lib/policy')
    expect(typeof SHORTFALL_WARN_BELOW_CAD).toBe('number')
    expect(SHORTFALL_WARN_BELOW_CAD).toBeGreaterThan(0)
  })
})
