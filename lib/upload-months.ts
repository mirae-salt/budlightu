/**
 * Month choices for the receipt upload selector.
 *
 * This MUST agree with `validatePeriod` in lib/period.ts, which is the authority:
 * the current or previous month, inside the cohort's dates, plus a current-month
 * exception for a test account. Offering anything else means the student uploads
 * and is then rejected, which is exactly the bug this replaced.
 *
 * It lives here rather than in the page so it can be unit tested against the same
 * cases as the server rule.
 */
import { PROGRAM_START_MONTH, PROGRAM_START_YEAR, PROGRAM_MONTHS } from './program'
import { isPastDeadline } from './deadline'

export type MonthOption = { value: string; label: string; shortLabel: string; tag?: string; isCurrent?: boolean; isSubmittable?: boolean }

/** The cohort's first and last month as YYYY-MM-01, so a string compare works. */
export type CohortWindow = { startMonth: string; endMonth: string }

/** UTC month key, matching lib/period.ts. `new Date(y, m, 1).toISOString()` is a
 *  LOCAL midnight, which at a negative UTC offset lands on the last day of the
 *  previous month, so a September receipt would be filed under August. */
export function monthValue(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}-01`
}

/**
 * Month choices for the selector.
 *
 * The list used to be exactly the 8 hardcoded program months (Sept 2026 - Apr
 * 2027), which broke in two ways:
 *   - Before the program starts, nothing in the list is acceptable to the server,
 *     so every submit failed with "You cannot submit receipts for a future month"
 *     and the message blamed the student.
 *   - The previous month was dropped by an index slice rather than a date test, so
 *     a student who missed the September deadline could not pick September in
 *     October even though the server would accept it.
 *
 * The server is the authority (lib/period.ts): it accepts the current or previous
 * month, inside the cohort's dates, and nothing else. So the list now always
 * contains those two months, flagged `isSubmittable`, plus the program months for
 * context. Anything not submittable is shown disabled with the reason, instead of
 * being offered and then rejected.
 */
export function buildMonthOptions(cohort: CohortWindow | null, isTestBam: boolean, now: Date = new Date()): MonthOption[] {
  const curYear = now.getUTCFullYear()
  const curMonth = now.getUTCMonth()

  const prev = new Date(Date.UTC(curYear, curMonth - 1, 1))
  const submittable = new Set([
    monthValue(curYear, curMonth),
    monthValue(prev.getUTCFullYear(), prev.getUTCMonth())
  ])

  const seen = new Set<string>()
  const opts: MonthOption[] = []

  const push = (year: number, month0: number) => {
    const value = monthValue(year, month0)
    if (seen.has(value)) return
    seen.add(value)

    const isCurrent = year === curYear && month0 === curMonth
    const monthStartUtc = Date.UTC(year, month0, 1)
    const thisMonthUtc = Date.UTC(curYear, curMonth, 1)

    // Both halves of the server rule (lib/period.ts): the current or previous
    // month, AND inside the cohort's dates. Checking only the first half is what
    // would leave August selectable in September once the cohort's start_date goes
    // back to the 1st of September, i.e. the same UI-allows/server-rejects bug
    // this function was just fixed for. Until the cohort loads, nothing outside
    // the date rule is offered.
    const inWindow = cohort ? value >= cohort.startMonth && value <= cohort.endMonth : true
    // Mirrors the server exception in lib/period.ts: a test account may submit for
    // the CURRENT month even outside the program window, so the flow can be
    // exercised before the program opens. Labelled "Test" rather than by month
    // name, because it is not a real program month and should not look like one.
    const isTestSlot = isTestBam && isCurrent && !inWindow
    const isSubmittable = (submittable.has(value) && inWindow) || isTestSlot

    let tag: string | undefined
    if (isTestSlot) tag = 'test only'
    else if (!isSubmittable) {
      if (!inWindow) tag = 'outside your program'
      else tag = monthStartUtc > thisMonthUtc ? 'not open yet' : 'closed'
    }
    // Was `now.getUTCDate() > 15`, which told a BC student they were past the deadline
    // from 5pm their own time ON the 15th, because by then it was the 16th in UTC. The
    // rule now lives in lib/deadline.ts and is stated in Eastern time.
    else if (isCurrent && isPastDeadline(now)) tag = 'past deadline'
    else if (monthStartUtc < thisMonthUtc) tag = 'late, still accepted'

    const monthName = new Date(monthStartUtc).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    opts.push({
      value,
      label: isTestSlot ? 'Test' : monthName,
      shortLabel: isTestSlot ? 'Test' : monthName.split(' ')[0],
      tag,
      isCurrent,
      isSubmittable
    })
  }

  // Always offer what the server will actually take, even outside the program
  // months. If it is outside the cohort's dates the server says so precisely.
  push(prev.getUTCFullYear(), prev.getUTCMonth())
  push(curYear, curMonth)
  for (let i = 0; i < PROGRAM_MONTHS; i++) {
    push(
      PROGRAM_START_YEAR + Math.floor((PROGRAM_START_MONTH + i) / 12),
      (PROGRAM_START_MONTH + i) % 12
    )
  }

  opts.sort((a, b) => a.value.localeCompare(b.value))
  return opts
}

