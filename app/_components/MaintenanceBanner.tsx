'use client'

/**
 * The maintenance banner strip.
 *
 * Shared by the portal and admin shells. Admins see it too, on purpose: it is
 * information rather than an obstacle, and it means an admin can tell at a glance that
 * a notice is live instead of opening a private window to check.
 *
 * Reads /api/maintenance, which is public and fails open. No deploy is involved in
 * turning it on or off: the state lives in the `policy` table, so saving on
 * /admin/maintenance changes what the next page load shows.
 *
 * It also re-checks on an interval, so a student sitting on the upload page finds out
 * that maintenance was announced without having to reload.
 */
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { shouldShowBanner, type MaintenanceState } from '@/lib/maintenance'

/** How often an already-open tab re-checks. Cheap: one small public JSON response. */
const POLL_MS = 60_000

export function MaintenanceBanner() {
  const path = usePathname()
  const [state, setState] = useState<MaintenanceState | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const check = async () => {
      try {
        const res = await fetch('/api/maintenance')
        const j = await res.json()
        if (cancelled) return
        const next = (j?.maintenance ?? null) as MaintenanceState | null
        setState(prev => {
          // A NEW notice un-dismisses itself. Otherwise dismissing this evening's
          // banner would hide next week's too, and the person who most needs to see
          // it is the one who already clicked the X once.
          const changed = prev?.message !== next?.message || prev?.on !== next?.on
          if (changed) setDismissed(false)
          return next
        })
      } catch {
        // Fail open: no banner rather than an error. See lib/maintenance.ts.
        if (!cancelled) setState(null)
      }
    }

    check()
    timer = setInterval(check, POLL_MS)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [])

  if (dismissed) return null
  if (!shouldShowBanner({ state, path: path ?? '' })) return null

  const until = state?.until
    ? new Date(state.until).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      })
    : null

  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 16px',
        background: '#fef3c7',
        borderBottom: '1px solid #fcd34d',
        color: '#78350f',
        fontSize: 13,
        lineHeight: 1.5
      }}
    >
      <svg
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ width: 16, height: 16, flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{state?.message}</strong>
        {until && <span style={{ marginLeft: 6, opacity: 0.85 }}>Expected back by {until}.</span>}
        {/*
         * THE DISCLAIMER, and why it is here rather than a real block.
         *
         * Banner mode leaves the portal fully working: this is a client-side notice, so every API
         * behind it is still live and an upload during maintenance may well go through. It may
         * also not. Without this line the banner says "we are working on it" while the page still
         * offers an Upload button, and a student who uses it and loses the file was told nothing.
         *
         * Saying so is the honest version of a limitation we are choosing to keep. Blocking
         * submissions for real would mean failing every portal API closed, which turns a Supabase
         * hiccup into a portal outage. Warning is the cheaper trade, but only if we actually warn.
         */}
        <span style={{ display: 'block', marginTop: 4, opacity: 0.9, fontWeight: 400 }}>
          You can still use the portal, but anything you submit right now may not be saved. If it
          matters, wait until this notice is gone and submit again.
        </span>
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Dismiss"
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: '#78350f', padding: 0, lineHeight: 1, fontSize: 16, flexShrink: 0
        }}
      >
        ×
      </button>
    </div>
  )
}
