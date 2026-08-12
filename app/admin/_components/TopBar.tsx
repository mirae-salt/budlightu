'use client'

import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'

type Notif = {
  id: string; type: string; title: string; body?: string
  link?: string; read: boolean; created_at: string
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

const TYPE_ICONS: Record<string, string> = {
  receipt_review: '⚠',
  ocr_failed: '✖',
  shortfall: '▼',
  invoice_draft: '✉',
  support_question: '❓',
  receipt_uploaded: '↑',
  banking_change_request: '🏦',
}

/**
 * Where the notification panel goes.
 *
 * It used to be `top: button.bottom + 8` and nothing else, which was fine while the bell sat
 * beside the logo at the top of the sidebar. The bell moved down next to the log out button on
 * 2026-08-12, and a 480px panel opening downward from there runs straight off the bottom of
 * the window: the notifications were rendered and unreadable.
 *
 * So it opens whichever way there is room, and never taller than the space it has. Also
 * clamped horizontally, because a fixed 380px panel is wider than a phone.
 */
const PANEL_GAP = 8
const PANEL_WIDTH = 380
const PANEL_MAX_HEIGHT = 480
/** Below this a panel is too short to be worth opening downward into. */
const PANEL_MIN_HEIGHT = 200

/**
 * What is actually visible, which on a phone is not window.innerHeight.
 *
 * innerHeight is the layout viewport and includes the strip under the URL bar. visualViewport
 * is what the person can see. Using the wrong one is how a panel measured as "fits" is rendered
 * half under the browser chrome.
 */
export function currentViewport(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 1280, height: 800 }
  const vv = window.visualViewport
  return {
    width: Math.round(vv?.width ?? window.innerWidth),
    height: Math.round(vv?.height ?? window.innerHeight)
  }
}

export type PanelPosition = {
  left: number
  width: number
  maxHeight: number
  /** Set when the panel opens downward. */
  top?: number
  /** Set when it opens upward. Anchoring by the bottom edge is load-bearing, see below. */
  bottom?: number
}

export function placePanel(
  r: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number } = currentViewport()
): PanelPosition {
  const spaceBelow = viewport.height - r.bottom - PANEL_GAP * 2
  const spaceAbove = r.top - PANEL_GAP * 2

  // Prefer downward, which is what people expect. Flip up only when down genuinely does not
  // work AND up is better, so a cramped window does not flip back and forth.
  const openDown = spaceBelow >= PANEL_MIN_HEIGHT || spaceBelow >= spaceAbove

  const available = openDown ? spaceBelow : spaceAbove
  // Never below the minimum: at that point the panel scrolls internally, which is readable,
  // where a 40px-tall panel is not.
  const maxHeight = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, available))

  const width = Math.min(PANEL_WIDTH, viewport.width - PANEL_GAP * 2)
  const left = Math.max(PANEL_GAP, Math.min(r.left, viewport.width - width - PANEL_GAP))

  if (openDown) return { top: r.bottom + PANEL_GAP, left, width, maxHeight }

  // OPENING UPWARD ANCHORS THE BOTTOM EDGE, NOT THE TOP.
  //
  // The first attempt set `top = r.top - GAP - maxHeight`. maxHeight is a MAXIMUM, so a panel
  // with four notifications in it is shorter than that and renders downward from `top`, leaving
  // the gap between its bottom and the bell equal to however much shorter it was. Measured on
  // 2026-08-12: the bell sat at y=715 and the panel ran 88 to 533, floating 180px above the
  // thing it belongs to.
  //
  // Anchoring the bottom puts the panel against the bell whatever its content height, and it
  // grows upward from there.
  return { bottom: viewport.height - r.top + PANEL_GAP, left, width, maxHeight }
}

export function NotificationBell() {
  const [notifs, setNotifs] = useState<Notif[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [dropPos, setDropPos] = useState<PanelPosition | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const load = () => {
    fetch('/api/admin/data?table=notifications')
      .then(r => r.json())
      .then(d => {
        setNotifs(d.data ?? [])
        setUnread(d.unreadCount ?? 0)
      })
      .catch(() => {})
  }

  // document.body does not exist while this renders on the server, so the portal waits a tick.
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  // Reposition while it is open. A phone's visible height changes when the URL bar slides away,
  // and rotating the device changes both dimensions. Without this the panel keeps the placement
  // it was given at the moment of the tap.
  useEffect(() => {
    if (!open) return
    const reposition = () => {
      if (btnRef.current) setDropPos(placePanel(btnRef.current.getBoundingClientRect()))
    }
    window.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      window.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
    }
  }, [open])

  useEffect(() => {
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const markAllRead = () => {
    fetch('/api/admin/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_all_read' })
    }).then(() => { load() })
  }

  const markRead = (id: string) => {
    fetch('/api/admin/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_read', ids: [id] })
    }).then(() => { load() })
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        onClick={() => {
          if (!open && btnRef.current) {
            setDropPos(placePanel(btnRef.current.getBoundingClientRect()))
          }
          setOpen(!open)
        }}
        style={{
          position: 'relative', background: 'none', border: 'none', cursor: 'pointer',
          padding: 6, borderRadius: 8, display: 'flex', alignItems: 'center',
        }}
        title="Notifications"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2,
            background: '#DC2626', color: '#fff', fontSize: 10, fontWeight: 700,
            minWidth: 16, height: 16, borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 4px', lineHeight: 1
          }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* PORTALLED TO document.body, not left inside the sidebar.
          .sidebar is overflow:hidden and, at mobile width, position:fixed. A panel rendered
          inside it depends on none of that ever becoming a containing block, which is a property
          nobody checks when they add a transition or a transform. Out here nothing above it can
          clip it, whatever CSS lands on the sidebar later. */}
      {open && dropPos && mounted && createPortal(
        <div style={{
          position: 'fixed', left: dropPos.left,
          // One of these is set, never both. See placePanel: upward anchors the bottom so the
          // panel touches the bell no matter how tall its contents turn out to be.
          ...(dropPos.top !== undefined ? { top: dropPos.top } : {}),
          ...(dropPos.bottom !== undefined ? { bottom: dropPos.bottom } : {}),
          width: dropPos.width, maxHeight: dropPos.maxHeight, overflowY: 'auto',
          background: 'var(--card-bg, #fff)', border: '1px solid var(--border)',
          borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          zIndex: 1000
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 16px 10px', borderBottom: '1px solid var(--border)'
          }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--bl-navy)' }}>
              Notifications {unread > 0 && <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--midgray)' }}>({unread} new)</span>}
            </span>
            {unread > 0 && (
              <button onClick={markAllRead} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 12, color: 'var(--bl-blue, #0088CE)', fontWeight: 600
              }}>
                Mark all read
              </button>
            )}
          </div>

          {notifs.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 13, color: 'var(--midgray)' }}>
              No notifications yet
            </div>
          ) : (
            notifs.map(n => (
              <div
                key={n.id}
                onClick={() => {
                  if (!n.read) markRead(n.id)
                  if (n.link) window.location.href = n.link
                  setOpen(false)
                }}
                style={{
                  display: 'flex', gap: 10, padding: '10px 16px', cursor: n.link ? 'pointer' : 'default',
                  background: n.read ? 'transparent' : 'rgba(0,136,206,0.04)',
                  borderBottom: '1px solid var(--border)',
                  transition: 'background 0.15s'
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.02)')}
                onMouseLeave={e => (e.currentTarget.style.background = n.read ? 'transparent' : 'rgba(0,136,206,0.04)')}
              >
                <span style={{ fontSize: 16, width: 24, textAlign: 'center', flexShrink: 0, paddingTop: 2 }}>
                  {TYPE_ICONS[n.type] ?? '•'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: n.read ? 400 : 600, color: 'var(--bl-navy)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>
                    {n.title}
                  </div>
                  {n.body && (
                    <div style={{
                      fontSize: 12, color: 'var(--midgray)', marginTop: 2,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                    }}>
                      {n.body}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--midgray)', marginTop: 3 }}>
                    {timeAgo(n.created_at)}
                  </div>
                </div>
                {!n.read && (
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', background: 'var(--bl-blue, #0088CE)',
                    flexShrink: 0, marginTop: 6
                  }} />
                )}
              </div>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

export function TopBar({ crumbs = ['Dashboard'] }: { crumbs?: string[] }) {
  return (
    <div className="topbar">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={i}>
            <span className={i === crumbs.length - 1 ? 'now' : ''}>{c}</span>
            {i < crumbs.length - 1 && <span className="sep" style={{ margin: '0 6px' }}>&rsaquo;</span>}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="searchbar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input placeholder='Search...' />
        </div>
      </div>
    </div>
  )
}
