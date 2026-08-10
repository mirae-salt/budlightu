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
export type ToastKind = 'ok' | 'error'
export type ToastNotice = { kind: ToastKind; text: string }

export function Toast({ notice, onDismiss }: { notice: ToastNotice | null; onDismiss: () => void }) {
  if (!notice) return null

  const isError = notice.kind === 'error'

  return (
    <div
      role="status"
      aria-live={isError ? 'assertive' : 'polite'}
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
        background: isError ? '#FDECEC' : '#EAF7EE',
        border: `1px solid ${isError ? 'rgba(163,18,18,0.35)' : 'rgba(22,120,60,0.3)'}`,
        boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
        color: isError ? '#7A0E0E' : '#12592F'
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1.4, flexShrink: 0 }}>
        {isError ? '⚠' : '✓'}
      </span>

      <div style={{ fontSize: 13.5, lineHeight: 1.55, flex: 1, minWidth: 0 }}>
        <strong style={{ display: 'block', marginBottom: 2 }}>
          {isError ? 'That did not go through' : 'Done'}
        </strong>
        {/* Server messages can be long and specific; let them wrap rather than clip. */}
        <span style={{ wordBreak: 'break-word' }}>{notice.text}</span>
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
