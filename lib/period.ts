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
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */

import { isPastDeadline, DEADLINE_DAY } from './deadline'

/** month index since year 0, for comparing YYYY-MM values without timezone drift */
function monthIndex(year: number, month1to12: number): number {
  return year * 12 + (month1to12 - 1)
}

function currentMonthIndex(now: Date): number {
  return monthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1)
}

export type PeriodOptions = {
  /**
   * `bams.is_test`. A test account may submit for the CURRENT month even when it
   * falls outside the cohort's dates, so the flow can be exercised before the
   * program opens. Everything else still applies: no future month, nothing older
   * than the previous month.
   *
   * This exists so nobody has to temporarily move a cohort's start_date to test,
   * which distorts the real program window and has to be remembered and reverted.
   * A real student (is_test false) is never granted the exception.
   */
  isTest?: boolean
  /**
   * Admin-only escape hatch for a month that is closed. The route handler sets this
   * ONLY after requireAdmin() succeeds and a non-empty reason was given -- it is never
   * read from client input directly, and the caller is responsible for writing the
   * audit_log row this promises.
   *
   * Scoped narrowly: it bypasses the two "this month is closed" refusals below and
   * nothing else. A future month is still refused (idx > cur, checked before this
   * option is even consulted), and a month outside the cohort's start_date..end_date
   * is still refused by the window check further down. This is for "the receipt is
   * real and just missed the deadline", not for granting a BAM a month their
   * program never had.
   *
   * This is the exception `validatePeriod`'s own closed-month message has promised
   * since 2026-08-14 ("ask on the Support page") without any code implementing it --
   * see the BLU Invoice Elle Edwards support ticket, 2026-09-16.
   */
  allowClosedOverride?: boolean
}

export function validatePeriod(
  raw: string,
  cohort: { start_date?: string | null; end_date?: string | null } | null,
  now: Date = new Date(),
  options: PeriodOptions = {}
): { ok: true; period: string } | { ok: false; message: string } {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(raw).trim())
  if (!m) return { ok: false, message: 'Invalid month. Expected YYYY-MM.' }
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return { ok: false, message: 'Invalid month.' }

  const idx = monthIndex(year, month)
  const cur = currentMonthIndex(now)
  if (idx > cur) return { ok: false, message: 'You cannot submit receipts for a future month.' }

  const period = `${m[1]}-${m[2]}-01`
  const monthName = new Date(`${m[1]}-${m[2]}-01T00:00:00Z`)
    .toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })

  // A test account may submit for the current month regardless of the cohort window
  // AND regardless of the deadline, so the flow can be exercised at any point in the
  // month. Checked before the deadline and window rules so testing is never blocked
  // by the calendar. Scoped to the CURRENT month: a test account still cannot backdate
  // or post ahead.
  const testException = options.isTest === true && idx === cur

  // CLOSED MONTHS ARE NOW REFUSED, not accepted and then ignored.
  //
  // This used to accept the previous month as well, which read as generous and was
  // the opposite. `scheduler-audit` only ever looks at the CURRENT month
  // (`.eq('period', period)`), and a month's invoice is generated a day or two after
  // its deadline. So a receipt filed against a closed month was stored, never
  // audited, never paid, and never surfaced to anyone: the student assumed they were
  // covered and no money moved. Refusing it up front is kinder than losing it
  // quietly, and it is the only version a student can act on.
  //
  // The deadline itself is generous by design (lib/deadline.ts: 08:00 UTC on the
  // 16th, which is midnight in BC), so "late" here really is late everywhere.
  // NOTE ON THE WORDING BELOW. It deliberately does NOT say "submit it with next
  // month's receipts". There is no rollover: each month has its own $150 cap and
  // unspent room does not carry (Robin, 2026-08-04). A receipt filed against next month
  // is charged to NEXT month's $150, so that advice would quietly cost the student the
  // cap they were trying to use, and would read as rollover when none exists.
  //
  // RESOLVED 2026-08-14 (BL Campus x AI Final Connect). The open question was which
  // month a purchase made AFTER the deadline belongs to. Robin: "that's kind of the
  // rule and that's what we train them on -- their product is purchased in the first
  // half of the month... we just keep it to say that so there's not any exceptions."
  // So this stays exactly as built: a closed month is refused, full stop, and the only
  // place a late purchase can go is the following cycle if the student submits it
  // there themselves. No new rule needed, and the message below still deliberately
  // does not invent a "submit it next month" instruction (see the note above it).
  if (!testException && !options.allowClosedOverride) {
    if (idx < cur) {
      return {
        ok: false,
        message: `${monthName} is closed. Its receipts were due on the ${DEADLINE_DAY}th. ` +
          'If there is a reason this one should still count, ask on the Support page.'
      }
    }
    if (idx === cur && isPastDeadline(now)) {
      return {
        ok: false,
        message: `${monthName}'s receipts closed on the ${DEADLINE_DAY}th. ` +
          'If there is a reason this one should still count, ask on the Support page.'
      }
    }
  }

  const range = (d?: string | null) => {
    const mm = d ? /^(\d{4})-(\d{2})/.exec(d) : null
    return mm ? monthIndex(Number(mm[1]), Number(mm[2])) : null
  }
  const startIdx = range(cohort?.start_date)
  const endIdx = range(cohort?.end_date)

  // Declared above, alongside the deadline rule it also bypasses.
  if (testException) return { ok: true, period }

  if (startIdx === null || endIdx === null) {
    return { ok: false, message: 'Your program dates are not set up yet. Please contact your program manager.' }
  }
  if (idx < startIdx || idx > endIdx) {
    return { ok: false, message: 'That month is outside your program dates.' }
  }

  return { ok: true, period }
}
