/**
 * Receipt `period` validation.
 *
 * P1-24: `period` used to be taken straight from the client, so a BAM could post
 * any month they liked and get a fresh $150 cap per fabricated month (or write a
 * receipt into a month that is already closed and invoiced).
 *
 * Accepted: "YYYY-MM" or "YYYY-MM-01", limited to the current or previous month,
 * and inside the cohort's start_date..end_date month range.
 *
 * This lives in lib/ rather than beside the route handler because a Next.js route
 * file may only export the recognized handler names; exporting a helper from it
 * fails the production type check.
 */

/** month index since year 0, for comparing YYYY-MM values without timezone drift */
function monthIndex(year: number, month1to12: number): number {
  return year * 12 + (month1to12 - 1)
}

function currentMonthIndex(now: Date): number {
  return monthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1)
}

export function validatePeriod(
  raw: string,
  cohort: { start_date?: string | null; end_date?: string | null } | null,
  now: Date = new Date()
): { ok: true; period: string } | { ok: false; message: string } {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(raw).trim())
  if (!m) return { ok: false, message: 'Invalid month. Expected YYYY-MM.' }
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return { ok: false, message: 'Invalid month.' }

  const idx = monthIndex(year, month)
  const cur = currentMonthIndex(now)
  if (idx > cur) return { ok: false, message: 'You cannot submit receipts for a future month.' }
  if (idx < cur - 1) return { ok: false, message: 'That month is closed. You can only submit for the current or previous month.' }

  const period = `${m[1]}-${m[2]}-01`

  const range = (d?: string | null) => {
    const mm = d ? /^(\d{4})-(\d{2})/.exec(d) : null
    return mm ? monthIndex(Number(mm[1]), Number(mm[2])) : null
  }
  const startIdx = range(cohort?.start_date)
  const endIdx = range(cohort?.end_date)
  if (startIdx === null || endIdx === null) {
    return { ok: false, message: 'Your program dates are not set up yet. Please contact your program manager.' }
  }
  if (idx < startIdx || idx > endIdx) {
    return { ok: false, message: 'That month is outside your program dates.' }
  }

  return { ok: true, period }
}
