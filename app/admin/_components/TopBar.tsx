'use client'

import {
  NotificationBell as SharedBell,
  type NotifItem
} from '../../_components/NotificationPanel'

/**
 * Placement is shared with the portal bell and lives in app/_components/NotificationPanel.tsx.
 * Re-exported here because tests/notification-panel.test.ts and any existing import still point
 * at this path, and because the admin bell is the reason those rules exist.
 */
export { placePanel, currentViewport, type PanelPosition } from '../../_components/NotificationPanel'

type Notif = NotifItem & {
  bam_id?: string | null
  /** Joined in /api/admin/data. Object or one-element array depending on the join. */
  bams?: { first_name: string | null; last_name: string | null; school_id: string | null }
    | Array<{ first_name: string | null; last_name: string | null; school_id: string | null }>
    | null
}

/** Who the notification is about, when it is about somebody. */
function subjectOf(n: Notif): string | null {
  const b = Array.isArray(n.bams) ? n.bams[0] : n.bams
  if (!b) return null
  const name = [b.first_name, b.last_name].filter(Boolean).join(' ').trim()
  if (!name) return null
  return b.school_id ? `${name} (${b.school_id})` : name
}

/**
 * A dot coloured by what the notification is about.
 *
 * This was a mix of text glyphs and emoji: an outline warning triangle next to a full-colour
 * bank emoji next to a question mark, at four apparent weights. They read as different icon
 * families because they were, and an emoji missing from the system font renders as a box.
 *
 * Colour carries the meaning instead. Amber for something waiting on a decision, red for
 * something that failed, blue for information.
 */
const TYPE_TONE: Record<string, string> = {
  receipt_review: '#d97706',
  banking_change_request: '#d97706',
  support_question: '#d97706',
  // Someone is waiting on an answer AND a payment is held up behind it.
  invoice_dispute: '#d97706',
  ocr_failed: '#dc2626',
  invoice_blocked: '#dc2626',
  shortfall: '#dc2626',
  invoice_draft: '#0073cf',
  receipt_uploaded: '#0073cf',
}

export function NotificationBell() {
  return (
    <SharedBell<Notif>
      tone={TYPE_TONE}
      subjectOf={subjectOf}
      load={async () => {
        const r = await fetch('/api/admin/data?table=notifications')
        const d = await r.json()
        return { items: (d.data ?? []) as Notif[], unread: d.unreadCount ?? 0 }
      }}
      mark={async body => {
        const res = await fetch('/api/admin/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        const j = await res.json().catch(() => null)
        if (!res.ok || !j?.ok) return j?.message ?? `Could not update (${res.status})`
        return null
      }}
    />
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
