'use client'
/**
 * Clickable sort headers, shared by /admin/invoices and /admin/roster.
 *
 * Mirae, 2026-09-15: *"작은 세모 표시 보여주면 정렬기능이 있구나~ 할듯"*. So both
 * triangles are drawn on every sortable header, dimmed, before anyone clicks.
 * A header that only grows an arrow after you click it never tells the person
 * who has not clicked that clicking does anything.
 *
 * Sorting here is display order only. Every caller keeps its unsorted array for
 * selection, totals and batch actions, so reordering the table cannot change
 * which rows an action applies to.
 */
import { useState } from 'react'

export type SortState<K extends string> = { key: K; dir: 1 | -1 } | null

/** null = whatever order the API returned. Set by clicking a header. */
export function useTableSort<K extends string>() {
  const [sort, setSort] = useState<SortState<K>>(null)

  /** Clicking the active column reverses it; clicking a new one starts ascending. */
  function toggleSort(key: K) {
    setSort(cur => (cur && cur.key === key ? { key, dir: (cur.dir * -1) as 1 | -1 } : { key, dir: 1 }))
  }

  return { sort, toggleSort }
}

/** Compare two display strings, empty last in both directions. */
export function compareText(a: string, b: string, dir: 1 | -1): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return a.localeCompare(b) * dir
}

export function SortTh<K extends string>({
  sortKey, sort, onSort, align, children
}: {
  sortKey: K
  sort: SortState<K>
  onSort: (key: K) => void
  align?: 'left' | 'right'
  children: React.ReactNode
}) {
  const dir = sort && sort.key === sortKey ? sort.dir : 0

  return (
    <th
      onClick={() => onSort(sortKey)}
      title="Click to sort"
      aria-sort={dir === 0 ? 'none' : dir === 1 ? 'ascending' : 'descending'}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', textAlign: align ?? 'left' }}
    >
      {children}
      <span
        aria-hidden="true"
        style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 0.75, fontSize: 8, marginLeft: 5, verticalAlign: 'middle' }}
      >
        <span style={{ color: dir === 1 ? 'var(--bl-navy)' : 'var(--midgray)', opacity: dir === 1 ? 1 : 0.4 }}>▲</span>
        <span style={{ color: dir === -1 ? 'var(--bl-navy)' : 'var(--midgray)', opacity: dir === -1 ? 1 : 0.4 }}>▼</span>
      </span>
    </th>
  )
}
