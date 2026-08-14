/**
 * When "the 15th" is over.
 *
 * WHY IT IS NOT MIDNIGHT
 * ----------------------
 * Robin raised the case this exists for: a BC ambassador submits at 11:30pm their time
 * on the 15th. That is 2:30am on the 16th in Toronto, and 06:30 UTC. The old test was
 * `now.getUTCDate() > 15`, so that person was marked late having submitted well inside
 * their own 15th -- and the label actually flipped at 5pm Pacific ON the 15th, because
 * by then it was already the 16th in UTC.
 *
 * The deadline is announced as "the 15th" with no timezone, to students spread across
 * Canada. So it ends when the 15th ends for the westernmost of them.
 *
 * WHY UTC WITH SLACK, RATHER THAN A TIMEZONE LIBRARY
 * -------------------------------------------------
 * Midnight in BC is 07:00 UTC in summer and 08:00 UTC in winter, because the program
 * runs September to April and crosses the end of daylight saving. Rather than convert
 * time zones to track that one hour, the cutoff is set at the later of the two. That
 * makes it exact in winter and an hour generous in summer.
 *
 * The point is the direction of the error: this can only ever give a student MORE time,
 * never less. Any drift lands on the side of the person who might otherwise lose $150.
 * There is no zone conversion, no DST table, and nothing to be subtly wrong about.
 *
 * THIS FILE IS THE CUTOFF, NOT THE GATE
 * Nothing here rejects anything. `lib/period.ts validatePeriod` does the rejecting, and it
 * CALLS isPastDeadline to decide. So the generosity above is real at the gate: measured
 * 2026-08-14, a submission for September at 06:30 UTC on Sep 16 (11:30pm Sep 15 in BC) is
 * accepted, and the same submission at 08:00 UTC is refused.
 *
 * A closed month is refused outright, which is stricter than this file's header used to
 * claim ("the server still accepts the current or previous month") -- that stopped being
 * true when period.ts started refusing closed months, because a receipt filed against a
 * closed month was stored, never audited and never paid. Robin confirmed the strict
 * reading on 2026-08-14: "we just keep it to say that so that there's not any exceptions."
 */

/** The day students are told to submit by. */
export const DEADLINE_DAY = 15

/**
 * The UTC hour on the FOLLOWING day at which the deadline is considered past.
 *
 * 8 = 08:00 UTC on the 16th, which is midnight in BC in winter and 1:00am in summer.
 * Robin's 2:30am-Eastern example is 06:30 UTC, comfortably inside it.
 *
 * This is the one number to move if the cutoff should change. Raising it gives more
 * grace; lowering it below 8 starts cutting into somebody's 15th out west.
 */
export const DEADLINE_CUTOFF_UTC_HOUR = 8

/**
 * Has the deadline passed?
 *
 * False through the whole of the 15th and the small hours of the 16th, which is what
 * keeps a late-evening Pacific submission on time.
 */
export function isPastDeadline(now: Date = new Date()): boolean {
  const day = now.getUTCDate()
  if (day <= DEADLINE_DAY) return false
  if (day === DEADLINE_DAY + 1) return now.getUTCHours() >= DEADLINE_CUTOFF_UTC_HOUR
  return true
}

/**
 * The spending window a period actually covers, in plain words.
 *
 * Confirmed with Mirae on 2026-08-12: because receipts close on the 15th and there is
 * NO rollover, a month's $150 covers purchases from the 16th of the previous month
 * through the 15th of this one. Every label in the product says "September", which a
 * student reads as September 1-30, so the window has to be spelled out next to it or
 * they will buy on the 20th expecting it to count.
 *
 * `period` is "YYYY-MM" or "YYYY-MM-01".
 */
export function spendingWindowLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(period)
  if (!m) return ''
  const year = Number(m[1])
  const month0 = Number(m[2]) - 1

  const end = new Date(Date.UTC(year, month0, DEADLINE_DAY))
  // Day 0 of this month is the last day of the previous one; +16 lands on the 16th.
  const start = new Date(Date.UTC(year, month0 - 1, DEADLINE_DAY + 1))

  const fmt = (d: Date) =>
    d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

  return `${fmt(start)} to ${fmt(end)}`
}
