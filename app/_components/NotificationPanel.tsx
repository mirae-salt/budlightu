'use client'

/**
 * The notification bell and its panel, shared by the admin shell and the BAM portal.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * All of this lived in app/admin/_components/TopBar.tsx. The student bell needed the same
 * behaviour, and copying it would have meant the next placement bug gets fixed in one of two
 * copies. Everything below was paid for by a bug already fixed once:
 *
 *   - portalling out of the sidebar, because .sidebar is overflow:hidden
 *   - measuring against visualViewport, because innerHeight is not what a phone shows
 *   - anchoring the BOTTOM edge when the panel opens upward
 *   - checking the portalled panel in the outside-click handler
 *   - awaiting the mark-read write before navigating
 *   - reading the response of that write instead of assuming it worked
 *
 * What differs between the two bells is data and colour, so that is what the props carry.
 * Nothing in here knows about admins, students, receipts or invoices.
 */

import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'

export type NotifItem = {
  id: string
  type: string
  title: string
  body?: string | null
  link?: string | null
  read: boolean
  created_at: string
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
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

export const TYPE_TONE_DEFAULT = '#9ca3af'

export type NotificationBellProps<T extends NotifItem> = {
  /**
   * Load the list. Resolves to what is shown; a rejection leaves the last good list in place.
   *
   * `hidden: true` removes the bell entirely, for a viewer who has no notifications of their
   * own to see rather than none right now: a signed-out visitor, or an admin with no roster
   * row. The alternative was gating the bell on a client-side session check, which is a second
   *, differently-wrong copy of a question the server already answers.
   */
  load: () => Promise<{ items: T[]; unread: number; hidden?: boolean }>
  /** Mark read. Resolves to an error message, or null on success. */
  mark: (body: { action: 'mark_read' | 'mark_all_read'; ids?: string[] }) => Promise<string | null>
  /** Dot colour by notification type. Anything unlisted is grey. */
  tone?: Record<string, string>
  /** An optional second line, e.g. who the notification is about. Admin uses it; students do not. */
  subjectOf?: (n: T) => string | null
  /** Shown when there is nothing at all, as opposed to nothing unread. */
  emptyText?: string
  /** Poll interval in ms. */
  refreshMs?: number
}

export function NotificationBell<T extends NotifItem>({
  load: loadFn,
  mark,
  tone = {},
  subjectOf,
  emptyText = 'No notifications yet',
  refreshMs = 30000
}: NotificationBellProps<T>) {
  const [notifs, setNotifs] = useState<T[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [dropPos, setDropPos] = useState<PanelPosition | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  // loadFn is rebuilt on every render by callers that inline it, so it is held in a ref and
  // kept out of the effect deps. Otherwise the poll interval is torn down and recreated on
  // every render, which is both a leak and a way to poll far more often than intended.
  const loadRef = useRef(loadFn)
  loadRef.current = loadFn

  /**
   * Starts VISIBLE and hides once the server says this viewer has no bell.
   *
   * The other way round would blink the bell out of existence for all 58 students on every
   * page load while their first request was in flight, to spare a rare signed-out visitor a
   * brief empty bell. Optimising for the common case.
   */
  const [hidden, setHidden] = useState(false)

  const load = async () => {
    try {
      const r = await loadRef.current()
      setNotifs(r.items)
      setUnread(r.unread)
      setHidden(Boolean(r.hidden))
    } catch {
      // Leave the previous list on screen. A transient failure blanking the panel looks like
      // the notifications were deleted.
    }
  }

  const router = useRouter()
  /** The portalled panel. Needed by the outside-click check, which cannot use `ref` any more. */
  const panelRef = useRef<HTMLDivElement | null>(null)
  /** Read ones are hidden by default. See the toggle at the foot of the panel. */
  const [showRead, setShowRead] = useState(false)
  const readCount = notifs.filter(n => n.read).length
  const visible = showRead ? notifs : notifs.filter(n => !n.read)

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
    void load()
    const interval = setInterval(() => { void load() }, refreshMs)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMs])

  /**
   * Close on a click outside. Has to check the PANEL as well as the bell.
   *
   * The panel was moved into a portal on document.body to stop the sidebar clipping it. That made it
   * stop being a DOM descendant of `ref`, so `!ref.current.contains(e.target)` was true for clicks
   * INSIDE the panel: mousedown closed it, the panel unmounted, and the click never reached the
   * item's onClick. So notifications did not navigate and did not mark themselves read, and the two
   * fixes I had already made to that handler could not run at all.
   *
   * Reported three times before I stopped guessing and read this function. `contains` on a portalled
   * child is the thing to check first whenever a dropdown stops responding.
   */
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const t = e.target as Node
      const inBell = ref.current?.contains(t)
      const inPanel = panelRef.current?.contains(t)
      if (!inBell && !inPanel) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  /**
   * Both of these used `.then(() => load())` and never looked at the response.
   *
   * The server side is fine: mark_read returns 200 with updated:1 and the unread count drops,
   * measured 2026-08-12. But an unchecked fetch means a 400 or a 500 produces exactly the same
   * visible result as success, which is nothing, and "I clicked it and it did not work" then has
   * no evidence attached to it either way. The response is checked now and a failure says so.
   */
  const [markError, setMarkError] = useState<string | null>(null)

  async function postMark(body: { action: 'mark_read' | 'mark_all_read'; ids?: string[] }): Promise<boolean> {
    setMarkError(null)
    const err = await mark(body).catch((e: unknown) => (e instanceof Error ? e.message : 'request failed'))
    if (err) { setMarkError(err); return false }
    await load()
    return true
  }

  const markAllRead = () => { void postMark({ action: 'mark_all_read' }) }
  const markRead = (id: string) => postMark({ action: 'mark_read', ids: [id] })

  // After the hooks, never before: an early return above them changes the hook order between
  // renders and React throws.
  if (hidden) return null

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
        {/* 17, not 20. The log out glyph beside it is 15 and the avatar is 28, so a 20px bell
            was the largest thing in the account row and read as the primary action there. */}
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span style={{
            // 13px, down from 16. The bell went from 20 to 17 and the badge did not follow, so a
            // two-digit count was nearly as wide as the icon it sat on.
            position: 'absolute', top: 0, right: 0,
            background: '#DC2626', color: '#fff', fontSize: 9, fontWeight: 700,
            minWidth: 13, height: 13, borderRadius: 999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 3px', lineHeight: 1
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
        <div ref={panelRef} style={{
          position: 'fixed', left: dropPos.left,
          // One of these is set, never both. See placePanel: upward anchors the bottom so the
          // panel touches the bell no matter how tall its contents turn out to be.
          ...(dropPos.top !== undefined ? { top: dropPos.top } : {}),
          ...(dropPos.bottom !== undefined ? { bottom: dropPos.bottom } : {}),
          width: dropPos.width, maxHeight: dropPos.maxHeight, overflowY: 'auto',
          background: '#fff',
          borderRadius: 14,
          /*
           * A 1px ring and THREE layered shadows, replacing `border: 1px solid var(--border)`
           * with a single 0 8px 32px blur.
           *
           * Two things were wrong with that. var(--border) is a pale grey that disappears against
           * the light page and is invisible against the navy sidebar, so the panel had no edge on
           * either side of itself. And one wide soft blur reads as fog rather than as height: the
           * panel looked like it was dissolving into the page instead of sitting above it.
           *
           * The ring is drawn as a shadow with 1px spread rather than a border so it does not take
           * part in layout, and it holds its contrast over both backgrounds. The shadows are tight,
           * medium and wide, which is the layering every design system converges on for overlay
           * elevation: the tight one defines the edge, the wide one places it above the page.
           */
          boxShadow: [
            '0 0 0 1px rgba(15,23,42,0.10)',
            '0 1px 2px rgba(15,23,42,0.06)',
            '0 8px 16px -6px rgba(15,23,42,0.10)',
            '0 24px 48px -16px rgba(15,23,42,0.22)'
          ].join(', '),
          zIndex: 1000
        }}>
          {/* Sticky, so the title and Mark all read stay reachable while the list scrolls. The
              border underneath doubles as the standard cue that there is content out of view. */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 16px 10px', borderBottom: '1px solid rgba(15,23,42,0.08)',
            position: 'sticky', top: 0, background: '#fff', zIndex: 1
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

          {markError && (
            <div style={{
              padding: '10px 16px', fontSize: 12, color: '#991b1b',
              background: 'rgba(220,38,38,0.06)', borderBottom: '1px solid rgba(15,23,42,0.06)'
            }}>
              {markError}
            </div>
          )}

          {visible.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 13, color: 'var(--midgray)' }}>
              {notifs.length === 0
                ? emptyText
                : showRead ? emptyText : 'Nothing new. You are caught up.'}
            </div>
          ) : (
            visible.map(n => (
              <div
                key={n.id}
                onClick={async () => {
                  // AWAITED. Firing the write and navigating in the same tick let the navigation
                  // cut the request short, so the notification was still unread on the way back.
                  if (!n.read) await markRead(n.id)
                  // router.push, not window.location.href. A full reload threw away the whole
                  // bundle and the page state to move between two screens in the same app.
                  if (n.link) router.push(n.link)
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
                <span
                  aria-hidden
                  style={{
                    width: 8, height: 8, borderRadius: 999, flexShrink: 0, marginTop: 6,
                    background: tone[n.type] ?? TYPE_TONE_DEFAULT,
                    // A read item keeps its colour but loses its weight, so the list still tells
                    // you what each row was about without competing with what is unread.
                    opacity: n.read ? 0.4 : 1
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: n.read ? 400 : 600, color: 'var(--bl-navy)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>
                    {n.title}
                  </div>
                  {/* The name first, then the detail. "Shortfall detected / $58.45 spent, under
                      the $75.00 soft floor" named an amount and no person, so the only way to act
                      on it was to go and work out who it was. */}
                  {subjectOf?.(n) && (
                    <div style={{
                      fontSize: 12, color: 'var(--bl-navy)', fontWeight: 500, marginTop: 2,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                    }}>
                      {subjectOf(n)}
                    </div>
                  )}
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

          {/* Read notifications leave the list, they are not deleted.
              Mirae asked for them to disappear once read, which is right: this is a queue of what
              needs attention, and a two-day-old item that was already dealt with sitting at the
              top of it is what made the panel not worth opening. But throwing them away would
              lose the only record that an alert ever fired, so they move behind this instead. */}
          {readCount > 0 && (
            <button
              onClick={() => setShowRead(v => !v)}
              style={{
                display: 'block', width: '100%', textAlign: 'center',
                padding: '10px 16px', background: 'rgba(15,23,42,0.02)',
                border: 'none', borderTop: '1px solid rgba(15,23,42,0.06)',
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
                color: 'var(--bl-blue, #0073cf)'
              }}
            >
              {showRead
                ? 'Hide read'
                : `Show ${readCount} already read`}
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
