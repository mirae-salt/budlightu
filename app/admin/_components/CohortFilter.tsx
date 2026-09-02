'use client'
/**
 * The cohort picker shared by /admin/roster and /admin/invoices.
 *
 * Robin, 2026-09-02, right after loading the 57 real BAMs alongside the 11 test
 * accounts: *"if we could show just on our browser the cohort we actually want to
 * look at, that would be super helpful"*, and *"we can keep all the testers, just
 * if we want to test stuff obviously in the back end"*. So the test rows stay in
 * the database and stop being in the way.
 *
 * One component rather than one per page, because the two screens have to agree.
 * A cohort chosen on the roster is still chosen on the invoices screen: picking
 * "Class of 2027" in one place and seeing TEST invoices in the other is how
 * somebody approves a payment they did not mean to look at.
 *
 * Both filters default to showing everything. A filter that hides rows before
 * anyone asks for it is how a present BAM gets reported missing.
 */
import { useEffect, useState } from 'react'

export type CohortOption = { id: string; name: string; start_date?: string | null }

export type Filters = { cohortFilter: string; hideTest: boolean }

const KEY = 'blu.admin.filters'
const DEFAULTS: Filters = { cohortFilter: 'all', hideTest: false }

function readFilters(): Filters {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
    return {
      cohortFilter: typeof saved.cohortFilter === 'string' ? saved.cohortFilter : DEFAULTS.cohortFilter,
      hideTest: typeof saved.hideTest === 'boolean' ? saved.hideTest : DEFAULTS.hideTest,
    }
  } catch {
    // Storage blocked or corrupt. The defaults show everything, which is the safe way to be wrong.
    return DEFAULTS
  }
}

export function useCohortFilter() {
  const [filters, setFiltersState] = useState<Filters>(DEFAULTS)
  const [cohortOptions, setCohortOptions] = useState<CohortOption[]>([])

  useEffect(() => {
    setFiltersState(readFilters())
    fetch('/api/admin/data?table=cohorts')
      .then(res => res.json())
      .then(({ data }) => setCohortOptions(
        Array.isArray(data)
          ? (data as CohortOption[])
              .map(c => ({ id: c.id, name: c.name, start_date: c.start_date ?? null }))
              // Newest first, so the cohort somebody is actually working in is
              // the one that survives the overflow cut below.
              .sort((a, b) => String(b.start_date ?? '').localeCompare(String(a.start_date ?? '')) || a.name.localeCompare(b.name))
          : []
      ))
      .catch(() => setCohortOptions([]))
  }, [])

  /** Written on change, not from an effect: an effect keyed on the state would fire
   *  once with the defaults before the read above lands and wipe a saved choice. */
  function setFilters(next: Partial<Filters>) {
    const merged = { ...filters, ...next }
    setFiltersState(merged)
    try { localStorage.setItem(KEY, JSON.stringify(merged)) } catch { /* not worth failing over */ }
  }

  /** True when a row belongs in the current view. `isTest` is optional: the
   *  invoices screen has no per-BAM test flag, only the cohort. */
  function matches(row: { cohortId: string | null; isTest?: boolean }): boolean {
    if (filters.hideTest && row.isTest) return false
    if (filters.cohortFilter === 'all') return true
    if (filters.cohortFilter === 'none') return !row.cohortId
    return row.cohortId === filters.cohortFilter
  }

  return { ...filters, setFilters, cohortOptions, matches }
}

/** Most rows fit on one line, so most of the time this is buttons. */
export const MAX_PILLS = 4

/**
 * Decides which choices get a button and which fold into a select.
 *
 * A cohort is added every school year, so the row grows on its own and would
 * eventually wrap into a block of buttons nobody reads. Up to MAX_PILLS nothing
 * folds and the row looks exactly as it does today.
 *
 * The active choice is always a button, even when it belongs to the folded set.
 * That is the whole reason this is not just a select: a filter you cannot see at
 * a glance is what makes a short list look like a complete one, and on the
 * invoices screen that list is money.
 *
 * Exported and pure so the swap can be tested without a browser or a login.
 */
export function splitPills(
  choices: CohortOption[],
  activeId: string,
  max: number = MAX_PILLS
): { pills: CohortOption[]; folded: CohortOption[] } {
  if (choices.length <= max) return { pills: choices, folded: [] }

  const pills = choices.slice(0, max)
  const folded = choices.slice(max)

  const active = folded.find(c => c.id === activeId)
  if (!active) return { pills, folded }

  // Swap the active choice into the last visible slot, and send the choice it
  // displaced to the front of the folded list so nothing is lost.
  return {
    pills: [...pills.slice(0, max - 1), active],
    folded: [pills[max - 1], ...folded.filter(c => c.id !== activeId)]
  }
}

/**
 * Segmented buttons, matching the send-mode control on the cohorts page
 * (btn-navy for the active choice, btn-ghost for the rest), with a select for
 * the overflow once there are enough cohorts to need one.
 *
 * This replaced a "Showing 57 of 68, 11 hidden" line that used to sit beside a
 * plain dropdown. That line existed because a collapsed dropdown left the active
 * filter as one unread word. A lit-up button says the same thing without a
 * sentence explaining it.
 */
export function CohortFilterBar({
  cohortFilter,
  hideTest,
  setFilters,
  cohortOptions,
  showTestToggle = true,
  showNoCohort = false,
}: {
  cohortFilter: string
  hideTest: boolean
  setFilters: (next: Partial<Filters>) => void
  cohortOptions: CohortOption[]
  /** The invoices screen has no per-BAM test flag, so it hides this checkbox. */
  showTestToggle?: boolean
  showNoCohort?: boolean
}) {
  const choices: CohortOption[] = [
    { id: 'all', name: 'All' },
    ...cohortOptions,
    ...(showNoCohort ? [{ id: 'none', name: 'No cohort' }] : []),
  ]

  const { pills, folded } = splitPills(choices, cohortFilter)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '2px 0 14px' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {pills.map(c => (
          <button
            key={c.id}
            className={cohortFilter === c.id ? 'btn-navy' : 'btn-ghost'}
            style={{ fontSize: 12, padding: '5px 14px' }}
            onClick={() => setFilters({ cohortFilter: c.id })}
          >
            {c.name}
          </button>
        ))}

        {folded.length > 0 && (
          <select
            value=""
            onChange={e => { if (e.target.value) setFilters({ cohortFilter: e.target.value }) }}
            style={{ fontSize: 12, padding: '5px 8px', maxWidth: 150 }}
          >
            <option value="">{folded.length} more…</option>
            {folded.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>

      {showTestToggle && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 400, cursor: 'pointer', color: 'var(--slate)' }}>
          <input type="checkbox" checked={hideTest} onChange={e => setFilters({ hideTest: e.target.checked })} />
          Hide test accounts
        </label>
      )}
    </div>
  )
}
