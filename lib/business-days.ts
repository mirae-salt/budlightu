/**
 * Business days, for "if the send day is a weekend, it goes out the next business day".
 *
 * WHY THIS IS DISPLAY-ONLY
 * ------------------------
 * The AP send is a person pressing a button (Janet batch-selects and sends), so nothing
 * here can force a date. What it does is let the portal tell a BAM the day their invoice
 * is actually expected to go out, instead of a date that falls on a Saturday and quietly
 * slips. A wrong promise on that screen is the thing this prevents.
 *
 * WHY NO HOLIDAY TABLE
 * --------------------
 * Weekends only, on purpose. A statutory holiday list is province-specific (this program
 * runs across Ontario, Quebec, Alberta, Nova Scotia and BC), it goes stale every year,
 * and a stale table would state a send date more confidently and less correctly than
 * saying nothing. Janet knows the holidays; the screen just needs to stop promising
 * Saturdays. If a holiday list is ever wanted, it belongs in `policy`, edited by Robin,
 * not hardcoded here.
 *
 * All arithmetic is UTC, matching lib/deadline.ts and lib/period.ts. Mixing local dates
 * into this file is how "the 17th" becomes the 16th for anyone west of Toronto.
 */

/** Saturday or Sunday, in UTC. */
export function isWeekend(d: Date): boolean {
  const day = d.getUTCDay()
  return day === 0 || day === 6
}

/**
 * The same day if it is already a business day, otherwise the next one.
 *
 * Returns a new Date; the argument is not modified.
 */
export function nextBusinessDay(d: Date): Date {
  const out = new Date(d.getTime())
  // At most two steps from any weekend, but loop rather than special-case so adding a
  // holiday rule later does not need this rewritten.
  while (isWeekend(out)) {
    out.setUTCDate(out.getUTCDate() + 1)
  }
  return out
}

/**
 * When an invoice released at `releasedAt` can go to AP: 24 hours later, moved to the
 * next business day if that lands on a weekend.
 *
 * The 24 hours is the BAM's objection window and is never shortened by this function.
 * A weekend can only push the send later, never earlier.
 */
export function sendEligibleAt(releasedAt: Date, windowHours = 24): Date {
  const windowEnds = new Date(releasedAt.getTime() + windowHours * 60 * 60 * 1000)
  return nextBusinessDay(windowEnds)
}

/**
 * When the BAM's window actually started, given that a correction restarts it (0036).
 *
 * A revision does not un-publish an invoice; it moves the clock to the moment the figure
 * changed. Taking the later of the two means the 24 hours always run against the number
 * the BAM was last shown, and never against one that has since been replaced.
 *
 * Returns null when the invoice has not been released, which is the caller's cue to
 * refuse the send outright rather than compute a deadline for something nobody has seen.
 */
export function windowStartedAt(
  releasedAt: string | Date | null | undefined,
  revisedAt: string | Date | null | undefined
): Date | null {
  if (!releasedAt) return null
  const released = new Date(releasedAt)
  if (!revisedAt) return released
  const revised = new Date(revisedAt)
  // A revision recorded BEFORE the release belongs to an older cycle and is ignored:
  // it cannot shorten or extend a window that started after it.
  return revised > released ? revised : released
}
