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

export type CohortOption = { id: string; name: string }

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
      .then(({ data }) => setCohortOptions(Array.isArray(data) ? data.map((c: CohortOption) => ({ id: c.id, name: c.name })) : []))
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

/**
 * Segmented buttons rather than a select, matching the send-mode control on the
 * cohorts page (btn-navy for the active choice, btn-ghost for the rest).
 *
 * This also replaces the "Showing 57 of 68, 11 hidden" line that used to sit
 * beside it. That line existed because a filter's failure mode is a short list
 * that looks complete, and with a collapsed dropdown the active filter was one
 * unread word. Here the chosen cohort is lit up on screen at all times, so the
 * state is visible without a sentence explaining it.
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

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '2px 0 14px' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {choices.map(c => (
          <button
            key={c.id}
            className={cohortFilter === c.id ? 'btn-navy' : 'btn-ghost'}
            style={{ fontSize: 12, padding: '5px 14px' }}
            onClick={() => setFilters({ cohortFilter: c.id })}
          >
            {c.name}
          </button>
        ))}
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
