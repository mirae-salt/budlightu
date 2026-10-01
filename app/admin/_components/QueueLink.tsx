/**
 * A link to a review queue, shown on the page that queue belongs to.
 *
 * WHY THESE LEFT THE SIDEBAR
 * --------------------------
 * Unmatched receipts and pending banking changes each had a permanent nav entry, and both are
 * empty almost all of the time. Dimming them helped and was not enough: they still occupied
 * two of eleven slots and read as parts of the program rather than as occasional work.
 *
 * They are not gone, they moved to where they are already relevant. Unmatched receipts are
 * receipts, so the link lives on the Receipts page. A banking change is a change to a roster
 * row, so it lives on the BAMs page. That is also where someone would look for them.
 *
 * REACHABLE AT ZERO, ON PURPOSE
 * -----------------------------
 * At zero this renders as one quiet line rather than disappearing. A queue that vanishes when
 * empty is a queue whose history can only be reached by typing the URL, and "nothing here
 * now" is different information from "this does not exist". Being on the page it belongs to
 * is what makes one quiet line affordable, where a permanent sidebar row was not.
 *
 * `hideWhenNone` is the exception, for a queue that has never had an entry. Unmatched onboarding
 * forms (a student typed an email that is not on the roster) have had none in the whole first
 * term, and a permanent green line on the Receipts page, called "receipts", read as a feature
 * that should be doing something. With the flag the row appears only when there is work.
 * The page itself stays at /admin/unmatched, and the count is still read, so a parked form
 * still shows up here the moment there is one.
 *
 * A count that cannot be read shows no number at all. Rendering 0 for a failed read is the
 * one wrong answer, because 0 is exactly what says nothing needs attention.
 */
'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

export function QueueLink({
  href,
  title,
  countKey,
  labelSome,
  labelNone,
  hideWhenNone = false
}: {
  href: string
  /** The queue's name, always shown, so the row is findable when the count is zero. */
  title: string
  countKey: 'unmatched' | 'banking'
  /** Shown when there is work. Receives the count, e.g. "3 receipts need matching". */
  labelSome: (n: number) => string
  /** Shown when the queue is empty. */
  labelNone: string
  /** Render nothing while the queue is empty. Default: one quiet line, see the header. */
  hideWhenNone?: boolean
}) {
  const [count, setCount] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    fetch('/api/admin/nav-counts')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        // undefined stays undefined (still loading / never answered), null means unreadable.
        if (j?.ok) setCount(j.counts?.[countKey] ?? null)
        else setCount(null)
      })
      .catch(() => { if (!cancelled) setCount(null) })
    return () => { cancelled = true }
  }, [countKey])

  // Nothing at all until the count is known. A box that says "0 waiting" and then changes to
  // "3 waiting" a moment later trains people to not read it.
  if (count === undefined) return null

  const waiting = typeof count === 'number' && count > 0

  if (!waiting && hideWhenNone && typeof count === 'number') return null

  if (!waiting) {
    // Same box, same position, quieter. A bare 12px sentence in muted grey was not findable:
    // Mirae could not see where Unmatched had gone, which for a moved page is the same as
    // having deleted it.
    return (
      <Link
        href={href}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
          padding: '10px 14px', borderRadius: 10, textDecoration: 'none',
          background: 'rgba(0,0,0,0.02)', border: '1px solid rgba(0,0,0,0.08)',
          color: 'var(--text-muted, #6b7280)', fontSize: 13
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: 999, background: '#22c55e', flexShrink: 0
        }} />
        <span><strong style={{ fontWeight: 600 }}>{title}</strong> {labelNone}</span>
        <span style={{ marginLeft: 'auto' }}>Open</span>
      </Link>
    )
  }

  return (
    <Link
      href={href}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
        padding: '11px 14px', borderRadius: 10, textDecoration: 'none',
        background: 'rgba(234,179,8,0.10)', border: '1px solid rgba(234,179,8,0.35)',
        color: '#854d0e', fontSize: 13, fontWeight: 600
      }}
    >
      <span style={{
        background: '#a16207', color: '#fff', borderRadius: 999,
        minWidth: 20, height: 20, display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 11, fontWeight: 700, padding: '0 6px'
      }}>{count}</span>
      <span><strong style={{ fontWeight: 700 }}>{title}</strong> {labelSome(count)}</span>
      <span style={{ marginLeft: 'auto', fontWeight: 400 }}>Review</span>
    </Link>
  )
}
