'use client'

/**
 * Fixed-position notice for the admin pages.
 *
 * Results used to render as a small inline badge next to whatever button was
 * pressed, which meant a failure was easy to miss entirely: the button looked
 * finished, the row appeared to change, and the explanation sat in 11px text
 * somewhere below the fold. On screens that move money that is the wrong way
 * round, so a failure now takes over a corner of the viewport until it is
 * dismissed, and a success fades on its own.
 *
 * Deliberately not a modal: it must never block the next action, and it must never
 * be a `window.alert`, which cannot be styled, cannot show two lines usefully and
 * can be suppressed by the browser.
 */
/**
 * 'next' is for work that SAVED and is not finished.
 *
 * Raising a banking correction from the roster writes a pending request that still has
 * to be approved. Reporting that as `ok` says "Done" over something that has not been
 * applied; reporting it as `error` says "That did not go through" over something that
 * went through perfectly, which is what it did at first and which Mirae caught. Neither
 * of the two existing kinds can say the true thing, so there is a third.
 *
 * Like `error` it does not fade, because it is asking for an action.
 */
export type ToastKind = 'ok' | 'error' | 'next'
export type ToastNotice = {
  kind: ToastKind
  text: string
  /**
   * Where the remaining step happens.
   *
   * Told to go to the Banking requests page, an admin has to find it in the sidebar, and
   * the new request only appears there after a real page load. A plain <a> is used rather
   * than a client-side navigation for exactly that reason: the whole point is to arrive
   * at a freshly fetched queue with the thing they just created in it.
   */
  action?: { label: string; href: string }
}

const STYLES: Record<ToastKind, { bg: string; border: string; fg: string; icon: string; heading: string }> = {
  ok:    { bg: '#EAF7EE', border: 'rgba(22,120,60,0.3)',  fg: '#12592F', icon: '✓', heading: 'Done' },
  error: { bg: '#FDECEC', border: 'rgba(163,18,18,0.35)', fg: '#7A0E0E', icon: '⚠', heading: 'That did not go through' },
  next:  { bg: '#FFF6E5', border: 'rgba(146,84,10,0.35)', fg: '#7A4B0E', icon: '!', heading: 'Saved. One more step' }
}

export function Toast({ notice, onDismiss }: { notice: ToastNotice | null; onDismiss: () => void }) {
  if (!notice) return null

  const s = STYLES[notice.kind] ?? STYLES.ok
  // Anything the user must act on is announced immediately, not when they next pause.
  const urgent = notice.kind !== 'ok'

  return (
    <div
      role="status"
      aria-live={urgent ? 'assertive' : 'polite'}
      style={{
        position: 'fixed',
        top: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        maxWidth: 'min(640px, calc(100vw - 32px))',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 10,
        background: s.bg,
        border: `1px solid ${s.border}`,
        boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
        color: s.fg
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1.4, flexShrink: 0 }}>
        {s.icon}
      </span>

      <div style={{ fontSize: 13.5, lineHeight: 1.55, flex: 1, minWidth: 0 }}>
        <strong style={{ display: 'block', marginBottom: 2 }}>
          {s.heading}
        </strong>
        {/* Server messages can be long and specific; let them wrap rather than clip. */}
        <span style={{ wordBreak: 'break-word' }}>{notice.text}</span>
        {/* Its own block. Inline-block put the button inside the text flow, so the last
            words of the sentence wrapped around it. */}
        {notice.action && (
          <div style={{ marginTop: 12 }}>
          <a
            href={notice.action.href}
            style={{
              display: 'inline-block',
              padding: '7px 13px',
              borderRadius: 6,
              background: s.fg,
              color: '#ffffff',
              textDecoration: 'none',
              fontSize: 12.5,
              fontWeight: 600
            }}
          >
            {notice.action.label}
          </a>
          </div>
        )}
      </div>

      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'inherit',
          fontSize: 18,
          lineHeight: 1,
          padding: '0 2px',
          flexShrink: 0
        }}
      >
        ×
      </button>
    </div>
  )
}
