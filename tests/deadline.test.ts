/**
 * Robin's case, pinned:
 *
 *   "I just don't want a BC rep to submit it at 11:30pm their time on the 15th and our
 *    system to receive it as 2:30am on the 16th and consider it late."
 *
 * Before this, the test was `now.getUTCDate() > 15`, so the portal called that student
 * late -- and in fact flipped the label at 5pm Pacific ON the 15th, because by then it
 * was already the 16th in UTC.
 *
 * The cutoff is 08:00 UTC on the 16th: midnight in BC in winter, 1am in summer. The
 * slack is deliberate and one-directional -- it can only ever give a student more time,
 * so there is nothing to get subtly wrong when the clocks change. The September and
 * February cases below are the two sides of that.
 */
import { describe, it, expect } from 'vitest'
import { isPastDeadline, DEADLINE_DAY, DEADLINE_CUTOFF_UTC_HOUR } from '../lib/deadline'

/** Written in UTC so the fixture does not depend on the machine running the test. */
const utc = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, min))

describe("Robin's BC case", () => {
  it('11:30pm Pacific on the 15th is NOT late', () => {
    // 11:30pm PDT Sept 15 = 06:30 UTC Sept 16 = 2:30am Eastern.
    expect(isPastDeadline(utc(2026, 9, 16, 6, 30))).toBe(false)
  })

  it('the old UTC-day rule would have called it late — the regression this guards', () => {
    const submitted = utc(2026, 9, 16, 6, 30)
    expect(submitted.getUTCDate() > DEADLINE_DAY).toBe(true) // the old rule
    expect(isPastDeadline(submitted)).toBe(false) // the new one
  })

  it('5pm Pacific on the 15th is not late either', () => {
    // Midnight UTC on the 16th: the exact moment the old label used to flip.
    expect(isPastDeadline(utc(2026, 9, 16, 0, 0))).toBe(false)
  })
})

describe('the cutoff', () => {
  it('is false all through the 15th', () => {
    expect(isPastDeadline(utc(2026, 9, 15, 0, 0))).toBe(false)
    expect(isPastDeadline(utc(2026, 9, 15, 23, 59))).toBe(false)
  })

  it('is false in the small hours of the 16th', () => {
    expect(isPastDeadline(utc(2026, 9, 16, 7, 59))).toBe(false)
  })

  it('becomes true at 08:00 UTC on the 16th', () => {
    expect(isPastDeadline(utc(2026, 9, 16, 8, 0))).toBe(true)
  })

  it('stays true for the rest of the month', () => {
    expect(isPastDeadline(utc(2026, 9, 16, 23, 0))).toBe(true)
    expect(isPastDeadline(utc(2026, 9, 30, 23, 0))).toBe(true)
  })

  it('resets at the start of the next month', () => {
    expect(isPastDeadline(utc(2026, 10, 1, 12, 0))).toBe(false)
    expect(isPastDeadline(utc(2026, 10, 14, 12, 0))).toBe(false)
  })
})

describe('the slack only ever runs in the student’s favour', () => {
  it('winter: midnight in BC is exactly the cutoff, so nobody loses their 15th', () => {
    // PST is UTC-8. Midnight PST Feb 16 = 08:00 UTC Feb 16.
    expect(isPastDeadline(utc(2027, 2, 16, 7, 59))).toBe(false) // 11:59pm PST on the 15th
    expect(isPastDeadline(utc(2027, 2, 16, 8, 0))).toBe(true)   // midnight PST on the 16th
  })

  it('summer: the same cutoff hands out an extra hour rather than taking one', () => {
    // PDT is UTC-7. Midnight PDT Sept 16 = 07:00 UTC, an hour before the cutoff.
    expect(isPastDeadline(utc(2026, 9, 16, 7, 0))).toBe(false)  // midnight PDT, still fine
    expect(isPastDeadline(utc(2026, 9, 16, 7, 59))).toBe(false) // 12:59am PDT, still fine
    expect(isPastDeadline(utc(2026, 9, 16, 8, 0))).toBe(true)   // 1:00am PDT
  })

  it('every Canadian time zone gets its whole 15th, in both seasons', () => {
    // Newfoundland is the earliest (UTC-2:30 in summer); Pacific the latest.
    // 11:59pm in each zone on the 15th must be on time.
    const lastMomentOfThe15th = [
      utc(2026, 9, 16, 2, 29),  // NDT  (UTC-2:30)
      utc(2026, 9, 16, 2, 59),  // ADT  (UTC-3)
      utc(2026, 9, 16, 3, 59),  // EDT  (UTC-4)
      utc(2026, 9, 16, 4, 59),  // CDT  (UTC-5)
      utc(2026, 9, 16, 5, 59),  // MDT  (UTC-6)
      utc(2026, 9, 16, 6, 59)   // PDT  (UTC-7)
    ]
    for (const t of lastMomentOfThe15th) {
      expect(isPastDeadline(t)).toBe(false)
    }
  })
})

describe('the constant is the one being described', () => {
  it('cutoff is 08:00 UTC, the later of the two BC midnights', () => {
    // If this moves, the cases above describe something else and the student-facing
    // copy needs to move with it.
    expect(DEADLINE_CUTOFF_UTC_HOUR).toBe(8)
    expect(DEADLINE_DAY).toBe(15)
  })
})
