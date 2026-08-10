import { describe, it, expect } from 'vitest'
import { buildMonthOptions } from '../lib/upload-months'
import { validatePeriod } from '../lib/period'

const cohortWindow = { startMonth: '2026-09-01', endMonth: '2027-04-01' }
const cohortDates = { start_date: '2026-09-01', end_date: '2027-04-30' }

describe('upload month selector', () => {
  it('before the program opens, a TEST account gets one option labelled "Test"', () => {
    const today = new Date('2026-08-10T12:00:00Z')
    const opts = buildMonthOptions(cohortWindow, true, today)
    const submittable = opts.filter(o => o.isSubmittable)

    expect(submittable).toHaveLength(1)
    expect(submittable[0].label).toBe('Test')
    expect(submittable[0].value).toBe('2026-08-01')
    expect(submittable[0].tag).toBe('test only')
    // No option is labelled by the real month name for that slot.
    expect(opts.map(o => o.label)).not.toContain('August 2026')
  })

  it('before the program opens, a real student has nothing to submit', () => {
    const today = new Date('2026-08-10T12:00:00Z')
    const opts = buildMonthOptions(cohortWindow, false, today)
    expect(opts.filter(o => o.isSubmittable)).toHaveLength(0)
  })

  it('the "Test" option disappears on its own once the program is open', () => {
    const sept = new Date('2026-09-05T12:00:00Z')
    const opts = buildMonthOptions(cohortWindow, true, sept)
    expect(opts.map(o => o.label)).not.toContain('Test')
    const submittable = opts.filter(o => o.isSubmittable)
    expect(submittable.map(o => o.label)).toEqual(['September 2026'])
  })

  it('in October, September is still offered (the late-submission case)', () => {
    const oct = new Date('2026-10-05T12:00:00Z')
    const labels = buildMonthOptions(cohortWindow, false, oct)
      .filter(o => o.isSubmittable).map(o => o.label)
    expect(labels).toContain('September 2026')
    expect(labels).toContain('October 2026')
  })

  it('every submittable option is actually accepted by the server rule', () => {
    const days = ['2026-08-10', '2026-09-05', '2026-10-05', '2027-04-20', '2027-05-05']
    for (const d of days) {
      for (const isTest of [true, false]) {
        const now = new Date(`${d}T12:00:00Z`)
        for (const o of buildMonthOptions(cohortWindow, isTest, now)) {
          const server = validatePeriod(o.value, cohortDates, now, { isTest })
          expect(
            server.ok,
            `${d} isTest=${isTest} ${o.label} (${o.value}): selector says submittable=${o.isSubmittable}, server says ${server.ok ? 'ok' : (server as { message: string }).message}`
          ).toBe(Boolean(o.isSubmittable))
        }
      }
    }
  })
})
