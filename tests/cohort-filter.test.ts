/**
 * Cohort filter overflow.
 *
 * A cohort is added every school year, so the button row grows on its own.
 * Folding the extras into a select is only safe if the active choice stays
 * visible: a filter you cannot see at a glance is what makes a short list look
 * like a complete one, and on the invoices screen that list is money.
 */
import { describe, it, expect } from 'vitest'
import { splitPills, MAX_PILLS, type CohortOption } from '../app/admin/_components/CohortFilter'

const make = (...names: string[]): CohortOption[] => names.map(n => ({ id: n, name: n }))
const ids = (cs: CohortOption[]) => cs.map(c => c.id)

describe('splitPills', () => {
  it('folds nothing while everything fits', () => {
    const choices = make('all', 'Class of 2027', 'TEST')
    const { pills, folded } = splitPills(choices, 'all')
    expect(ids(pills)).toEqual(['all', 'Class of 2027', 'TEST'])
    expect(folded).toHaveLength(0)
  })

  it('folds nothing at exactly the limit', () => {
    const choices = make('all', 'a', 'b', 'c')
    expect(splitPills(choices, 'all').folded).toHaveLength(0)
  })

  it('folds the overflow once past the limit', () => {
    const choices = make('all', 'a', 'b', 'c', 'd', 'e')
    const { pills, folded } = splitPills(choices, 'all')
    expect(pills).toHaveLength(MAX_PILLS)
    expect(ids(folded)).toEqual(['d', 'e'])
  })

  it('keeps the active choice visible when it would have been folded', () => {
    const choices = make('all', 'a', 'b', 'c', 'd', 'e')
    const { pills, folded } = splitPills(choices, 'e')
    expect(ids(pills)).toContain('e')
    expect(ids(folded)).not.toContain('e')
    expect(pills).toHaveLength(MAX_PILLS)
  })

  it('does not drop the choice the active one displaced', () => {
    const choices = make('all', 'a', 'b', 'c', 'd', 'e')
    const { pills, folded } = splitPills(choices, 'e')
    // 'c' loses its slot, so it has to turn up in the select.
    expect(ids(folded)).toContain('c')
    // Nothing is lost and nothing is duplicated.
    expect([...ids(pills), ...ids(folded)].sort()).toEqual(ids(choices).sort())
  })

  it('never loses a choice, whichever one is active', () => {
    const choices = make('all', 'a', 'b', 'c', 'd', 'e', 'f', 'g')
    for (const active of ids(choices)) {
      const { pills, folded } = splitPills(choices, active)
      const seen = [...ids(pills), ...ids(folded)]
      expect(seen.sort()).toEqual(ids(choices).sort())
      expect(new Set(seen).size).toBe(choices.length)
      expect(ids(pills)).toContain(active)
    }
  })

  it('leaves "All" reachable as a button in every case', () => {
    // "All" is first, so it is never the one that gets displaced: it is the way
    // back from any filter.
    const choices = make('all', 'a', 'b', 'c', 'd', 'e')
    for (const active of ids(choices)) {
      expect(ids(splitPills(choices, active).pills)).toContain('all')
    }
  })

  it('copes with an active id that is not in the list at all', () => {
    // A cohort saved in localStorage and later deleted.
    const choices = make('all', 'a', 'b', 'c', 'd', 'e')
    const { pills, folded } = splitPills(choices, 'deleted-cohort')
    expect(ids(pills)).toEqual(['all', 'a', 'b', 'c'])
    expect(ids(folded)).toEqual(['d', 'e'])
  })

  it('handles an empty list', () => {
    expect(splitPills([], 'all')).toEqual({ pills: [], folded: [] })
  })
})
