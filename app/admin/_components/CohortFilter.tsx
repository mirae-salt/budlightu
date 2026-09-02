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

export function CohortFilterBar({
  cohortFilter,
  hideTest,
  setFilters,
  cohortOptions,
  showTestToggle = true,
  showNoCohort = false,
  shown,
  hidden,
  noun,
}: {
  cohortFilter: string
  hideTest: boolean
  setFilters: (next: Partial<Filters>) => void
  cohortOptions: CohortOption[]
  /** The invoices screen has no per-BAM test flag, so it hides this checkbox. */
  showTestToggle?: boolean
  showNoCohort?: boolean
  shown: number
  hidden: number
  noun: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '4px 0 14px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        <span className="muted">Cohort</span>
        <select
          value={cohortFilter}
          onChange={e => setFilters({ cohortFilter: e.target.value })}
          style={{ maxWidth: 220 }}
        >
          <option value="all">All cohorts</option>
          {cohortOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          {showNoCohort && <option value="none">No cohort</option>}
        </select>
      </label>

      {showTestToggle && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={hideTest} onChange={e => setFilters({ hideTest: e.target.checked })} />
          Hide test accounts
        </label>
      )}

      {/* Hidden rows are always announced. A filter's failure mode is a short list
          that looks complete, and on the invoices screen that list is money. */}
      {hidden > 0 && (
        <span className="muted" style={{ fontSize: 12 }}>
          Showing {shown} of {shown + hidden} {noun}, {hidden} hidden
          <button
            className="btn-ghost"
            style={{ fontSize: 11, padding: '2px 8px', marginLeft: 8 }}
            onClick={() => setFilters({ cohortFilter: 'all', hideTest: false })}
          >
            Show all
          </button>
        </span>
      )}
    </div>
  )
}
