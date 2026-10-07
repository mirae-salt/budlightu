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
 * The first visit starts on the current live cohort. "All cohorts" remains
 * available for checking invoices outside that cohort.
 */
import { useEffect, useRef, useState } from 'react'

export type CohortOption = { id: string; name: string; start_date?: string | null; end_date?: string | null; send_mode?: string | null }

export type Filters = { cohortFilter: string; hideTest: boolean }

const KEY = 'blu.admin.filters.v2'
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

/** Pre-set the saved filter, for a link that should land on one cohort with test accounts hidden. */
export function presetCohortFilter(cohortFilter: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ cohortFilter, hideTest: true })) } catch { /* storage may be disabled */ }
}

export function useCohortFilter() {
  const [filters, setFiltersState] = useState<Filters>(DEFAULTS)
  const [cohortOptions, setCohortOptions] = useState<CohortOption[]>([])

  useEffect(() => {
    setFiltersState(readFilters())
    fetch('/api/admin/data?table=cohorts')
      .then(res => res.json())
      .then(({ data }) => {
        const options: CohortOption[] = Array.isArray(data)
          ? (data as CohortOption[])
              .map(c => ({ id: c.id, name: c.name, start_date: c.start_date ?? null, end_date: c.end_date ?? null, send_mode: c.send_mode ?? null }))
              // Newest first, so the cohort somebody is actually working in is
              // the one that survives the overflow cut below.
              .sort((a, b) => String(b.start_date ?? '').localeCompare(String(a.start_date ?? '')) || a.name.localeCompare(b.name))
          : []
        setCohortOptions(options)
        let hasSavedChoice = false
        try { hasSavedChoice = localStorage.getItem(KEY) !== null } catch { /* storage may be disabled */ }
        if (!hasSavedChoice) {
          const current = pickCurrentCohort(options, new Date().toISOString().slice(0, 10))
          if (current) setFiltersState({ cohortFilter: current.id, hideTest: false })
        }
      })
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

/** Prefer a live cohort spanning today; TEST/dry-run cohorts never win that tie. */
export function pickCurrentCohort(options: CohortOption[], today: string): CohortOption | undefined {
  const active = options.filter(c => c.start_date && c.end_date && c.start_date <= today && today <= c.end_date)
  return active.find(c => c.send_mode === 'live') ?? active[0]
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
  mode = 'pills',
  className,
  cohortLabel,
  trailing,
}: {
  cohortFilter: string
  hideTest: boolean
  setFilters: (next: Partial<Filters>) => void
  cohortOptions: CohortOption[]
  /** The invoices screen has no per-BAM test flag, so it hides this checkbox. */
  showTestToggle?: boolean
  showNoCohort?: boolean
  /** The compact menu keeps the invoice toolbar the same size as cohorts grow. */
  mode?: 'pills' | 'wrap' | 'select' | 'menu'
  /** Optional visual grouping for pages with multiple filters. */
  className?: string
  cohortLabel?: string
  /** Another control for the same row (the invoices screen puts its month picker here). */
  trailing?: React.ReactNode
}) {
  const choiceRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  useEffect(() => {
    if (!pickerOpen) return
    searchRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerOpen(false)
        choiceRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [pickerOpen])
  const choices: CohortOption[] = [
    { id: 'all', name: 'All' },
    ...cohortOptions,
    ...(showNoCohort ? [{ id: 'none', name: 'No cohort' }] : []),
  ]

  const { pills, folded } = splitPills(choices, cohortFilter)
  const selectedName = choices.find(c => c.id === cohortFilter)?.name ?? 'Selected cohort unavailable'
  const searchableChoices = choices.filter(c => c.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  return (
    <div
      className={className}
      style={{ display: 'flex', alignItems: 'center', gap: className ? 12 : 16, flexWrap: 'wrap', padding: className ? '14px 0 16px' : '2px 0 14px' }}
    >
      <div className="filterbar-group" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {cohortLabel && <span className="filterbar-label">{cohortLabel}</span>}
        {mode === 'menu' ? (
          <div className="cohort-picker" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPickerOpen(false) }}>
            <button
              ref={choiceRef}
              type="button"
              className="invoice-cohort-choice"
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              aria-label={`Cohort: ${selectedName}. Change cohort`}
              onClick={() => { setQuery(''); setPickerOpen(open => !open) }}
            >
              <span>{cohortFilter === 'all' ? 'All cohorts' : selectedName}</span>
              <span aria-hidden="true">⌄</span>
            </button>
            {pickerOpen && <div className="cohort-picker-menu">
                {choices.length > 5 && <input ref={searchRef} type="search" className="input" aria-label="Search cohorts" placeholder="Search cohorts…" value={query} onChange={e => setQuery(e.target.value)} />}
                <div className="cohort-picker-list" role="listbox" aria-label="Cohorts">
                  {searchableChoices.length === 0 ? (
                    <p>{query.trim() ? 'No matching cohorts' : 'No cohorts available'}</p>
                  ) : searchableChoices.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      className={cohortFilter === c.id ? 'is-selected' : ''}
                      role="option"
                      aria-selected={cohortFilter === c.id}
                      onClick={() => { setFilters({ cohortFilter: c.id }); setPickerOpen(false); choiceRef.current?.focus() }}
                    >
                      <span>{c.id === 'all' ? 'All cohorts' : c.name}</span>
                      {cohortFilter === c.id && <span aria-hidden="true">✓</span>}
                    </button>
                  ))}
                </div>
            </div>}
          </div>
        ) : mode === 'select' ? (
          <select
            aria-label={cohortLabel ?? 'Cohort'}
            value={cohortFilter}
            onChange={e => setFilters({ cohortFilter: e.target.value })}
            style={{ width: 'auto', minWidth: 170, maxWidth: 'min(280px, 55vw)' }}
          >
            {choices.map(c => (
              <option key={c.id} value={c.id}>{c.id === 'all' ? 'All cohorts' : c.name}</option>
            ))}
          </select>
        ) : (mode === 'wrap' ? choices : pills).map(c => (
          <button
            key={c.id}
            className={cohortFilter === c.id ? 'btn-navy' : 'btn-ghost'}
            style={{ fontSize: 12, padding: '5px 14px' }}
            onClick={() => setFilters({ cohortFilter: c.id })}
          >
            {c.name}
          </button>
        ))}

        {mode === 'pills' && folded.length > 0 && (
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

      {trailing}
    </div>
  )
}
