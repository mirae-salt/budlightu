/**
 * Did this student join after the month ended?
 *
 * The "Can't be sent yet" panel decided which months a student should have an invoice for
 * from the cohort's dates alone. A cohort that starts on 2026-09-01 made every student who
 * joined in October look as if September's invoice was missing (Hannah Duxbury and Alivia
 * Schulhauser, 2026-10-07). They were not in the program in September, so nothing was owed.
 *
 * Unknown or unparsable join time returns false: the panel then lists the student, which
 * is the side that shows a possibly missing invoice instead of hiding it.
 */
export function joinedAfterMonthEnded(createdAt: unknown, period: string): boolean {
  const created = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN
  if (Number.isNaN(created)) return false
  const [y, m] = period.split('-').map(Number)
  return created >= Date.UTC(y, m, 1)
}
