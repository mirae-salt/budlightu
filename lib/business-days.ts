// Authorship: Mirae Lee, BLU-MRL-20260720
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

const TORONTO = 'America/Toronto'

/** Weekday and calendar date of an instant, read on a Toronto wall clock. */
function torontoDate(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TORONTO, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23'
    }).formatToParts(d).map(x => [x.type, x.value])
  )
  return { weekday: p.weekday, y: +p.year, m: +p.month, d: +p.day, hour: +p.hour }
}

/** 00:00 Toronto on a calendar date. Eastern is UTC-4 or UTC-5 depending on the date, so try both. */
function torontoMidnight(y: number, m: number, d: number): Date {
  for (const h of [4, 5]) {
    const c = new Date(Date.UTC(y, m - 1, d, h))
    if (torontoDate(c).hour === 0) return c
  }
  throw new Error(`no Toronto midnight for ${y}-${m}-${d}`)
}

/**
 * When an invoice released at `releasedAt` can go to AP: 24 hours later, EXCEPT that a
 * window that ends on a Saturday or Sunday (Toronto time) opens at 00:00 Monday.
 *
 * The 24 hours is the BAM's objection window and is never shortened: a weekend end can
 * only push the send to Monday's start, which is later than the end itself.
 *
 * THE WEEKEND RULE IS MIRAE'S OWN AND IS IN WRITING. Teams, 2026-09-16, to the program
 * team: "On the 17th Janet batch-selects and sends to AP exactly as she does now. If the
 * 17th falls on a weekend or a holiday, the send moves to the next business day."
 * The day moves, not the hour. This used to keep the release's clock time, so an invoice
 * released Friday 17:52 became sendable Monday 17:52 although its 24 hours had ended
 * Saturday. Mirae, 2026-10-19: "금욜이면 24시간 이미 지난거잖아". Monday opens at 00:00.
 */
export function sendEligibleAt(releasedAt: Date, windowHours = 24): Date {
  const windowEnds = new Date(releasedAt.getTime() + windowHours * 60 * 60 * 1000)
  const t = torontoDate(windowEnds)
  if (t.weekday !== 'Sat' && t.weekday !== 'Sun') return windowEnds
  return torontoMidnight(t.y, t.m, t.d + (t.weekday === 'Sat' ? 2 : 1))
}

/**
 * When the BAM's window started: the moment the invoice was published, full stop.
 *
 * A CORRECTION DOES NOT RESTART IT (Mirae, 2026-09-16: "24시간 없음. 처음 24시간 내에서
 * 다 수정완료돼야함"). This briefly took the later of released_at and revised_at, which
 * read well and broke the thing the cadence exists for: the send day is fixed at the 17th,
 * so a clock that restarts on every correction moves the payment instead of the work.
 * Corrections belong inside the first window.
 *
 * `revised_at` still matters, just not here. It is what tells the BAM the figure moved and
 * what puts "Updated, please check again" on their row, against the same deadline.
 *
 * Returns null when the invoice has not been released, which is the caller's cue to refuse
 * the send outright rather than compute a deadline for something nobody has seen.
 */
export function windowStartedAt(releasedAt: string | Date | null | undefined): Date | null {
  return releasedAt ? new Date(releasedAt) : null
}
