'use client'

/**
 * The student's bell. Same component as the admin one (app/_components/NotificationPanel.tsx);
 * only the endpoints and the dot colours differ.
 *
 * No `subjectOf`: an admin notification has to say WHO it is about because it could be any of
 * 58 people. Every row here is about the person reading it.
 */

import { NotificationBell as SharedBell, type NotifItem } from '../../_components/NotificationPanel'

/**
 * Green for good news, red for something that did not go through, amber for something that
 * needs their attention, blue for information. The admin map has no green because nothing on
 * that board is good news; here the difference between an accepted and a rejected receipt is
 * the main thing the list is for.
 */
const TYPE_TONE: Record<string, string> = {
  receipt_approved: '#059669',
  receipt_rejected: '#dc2626',
  shortfall: '#d97706',
  invoice_sent: '#0073cf',
  question_answered: '#0073cf',
}

export function PortalNotificationBell() {
  return (
    <SharedBell<NotifItem>
      tone={TYPE_TONE}
      emptyText="Nothing yet. Receipt decisions and invoices show up here."
      load={async () => {
        const r = await fetch('/api/portal/notifications')
        const d = await r.json()
        return {
          items: (d.data ?? []) as NotifItem[],
          unread: d.unreadCount ?? 0,
          // No session (401) or no roster row (`applicable: false`) means there is no bell to
          // show this viewer. A 503 is NOT hidden: that is a temporary failure, and removing
          // the bell would say "you have no notifications" when the truthful answer is "we
          // could not look".
          hidden: r.status === 401 || d?.applicable === false
        }
      }}
      mark={async body => {
        const res = await fetch('/api/portal/notifications', {
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
