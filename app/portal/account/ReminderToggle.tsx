/**
 * The one control on the account page a BAM can actually set themselves.
 *
 * Everything else here files a request for a human to apply, because a portal that lets an
 * account holder rewrite their payout destination lets whoever steals that account do it too.
 * This one is different: the worst outcome of getting it wrong is one fewer email, and it is
 * reversible from the same screen.
 *
 * It renders nothing at all when there is no roster row (an admin browsing the portal). A
 * toggle that saves nowhere is worse than an absent one.
 */
'use client'

import { useEffect, useState } from 'react'

export function ReminderToggle() {
  const [wants, setWants] = useState<boolean | null>(null)
  const [applicable, setApplicable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/portal/reminders')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        if (j?.ok) {
          setApplicable(j.applicable !== false)
          setWants(Boolean(j.wants))
        } else {
          // Unknown is not "off". Leaving it null keeps the control out of the way rather than
          // claiming a setting we did not read.
          setApplicable(false)
        }
      })
      .catch(() => { if (!cancelled) setApplicable(false) })
    return () => { cancelled = true }
  }, [])

  if (!applicable || wants === null) return null

  async function save(next: boolean) {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/portal/reminders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wants: next })
      })
      const j = await res.json()
      if (!res.ok || !j?.ok) {
        setMsg({ ok: false, text: j?.message ?? 'That did not save.' })
      } else {
        // The value the server read back, not the one that was clicked.
        setWants(Boolean(j.wants))
        setMsg({
          ok: true,
          text: j.wants
            ? 'Saved. We will remind you before the deadline.'
            : 'Saved. We will not email you reminders.'
        })
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="surface" style={{ marginTop: 24, padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>Reminder emails</h2>
      <p className="subtle" style={{ fontSize: 13, margin: '0 0 14px', lineHeight: 1.6 }}>
        Before the 15th we can email you if we have not received any receipts from you that
        month. Nothing else about your reimbursement changes either way.
      </p>

      <label style={{
        display: 'flex', gap: 10, alignItems: 'flex-start',
        cursor: busy ? 'wait' : 'pointer', fontWeight: 400
      }}>
        <input
          type="checkbox"
          checked={wants}
          disabled={busy}
          onChange={e => void save(e.target.checked)}
          style={{ width: 'auto', marginTop: 3 }}
        />
        <span style={{ fontSize: 14 }}>
          Remind me before the deadline
          <span className="subtle" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
            {wants
              ? 'On. You will only hear from us in a month where you have submitted nothing.'
              : 'Off. You will not be reminded, and an unclaimed month cannot be claimed later.'}
          </span>
        </span>
      </label>

      {msg && (
        <p style={{ fontSize: 13, marginTop: 12, color: msg.ok ? '#065f46' : '#991b1b' }}>
          {msg.text}
        </p>
      )}
    </div>
  )
}
