'use client'

/**
 * The maintenance switch.
 *
 * A separate page rather than a control bolted onto the dashboard: this is the thing
 * you reach for when something is already going wrong, so it should not depend on the
 * dashboard rendering correctly.
 *
 * /admin is never covered by maintenance (lib/maintenance.ts), so this page stays
 * reachable while the switch is on. That is what makes it possible to turn it off.
 */
import { useEffect, useState, useCallback } from 'react'
import { TopBar } from '../_components/TopBar'
import { DEFAULT_MESSAGE, MAX_MESSAGE_LENGTH, type MaintenanceState } from '@/lib/maintenance'

export default function MaintenancePage() {
  const [state, setState] = useState<MaintenanceState | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [message, setMessage] = useState('')
  const [minutes, setMinutes] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/maintenance')
      const j = await res.json()
      setState(j?.maintenance ?? null)
      setDegraded(Boolean(j?.degraded))
      if (j?.maintenance?.message) setMessage(j.maintenance.message)
    } catch (e) {
      // Unknown is not "off". Say so rather than render a confident Off.
      setState(null)
      setDegraded(true)
      setNotice({ kind: 'error', text: `Could not read the switch: ${(e as Error).message}` })
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function save(on: boolean) {
    setBusy(true)
    setNotice(null)
    try {
      // "Back in N minutes" is turned into a timestamp here so the student-facing text
      // does not drift as time passes.
      const mins = parseInt(minutes, 10)
      const until = on && Number.isFinite(mins) && mins > 0
        ? new Date(Date.now() + mins * 60_000).toISOString()
        : null

      const res = await fetch('/api/maintenance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on, message: on ? message.trim() : '', until })
      })
      const j = await res.json()

      if (!res.ok || !j.ok) {
        setNotice({ kind: 'error', text: j.message || `Failed (${res.status})` })
        return
      }
      // Render what the server read back, not what was typed.
      setState(j.maintenance)
      setDegraded(false)
      setNotice({
        kind: j.warning ? 'error' : 'ok',
        text: j.warning
          ? `${j.maintenance.on ? 'Maintenance is ON' : 'Maintenance is OFF'}, but: ${j.warning}`
          : (j.maintenance.on
              ? 'Maintenance is ON. Students see the notice; you and other admins are unaffected.'
              : 'Maintenance is OFF. The portal is open.')
      })
    } catch (e) {
      setNotice({ kind: 'error', text: `Failed: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  const isOn = state?.on === true

  return (
    <>
      <TopBar crumbs={['System', 'Maintenance']} />
      <div className="surface" style={{ maxWidth: 620 }}>
        <div style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 4 }}>
            Maintenance mode
          </h2>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
            Shows BAMs a short notice instead of the portal. Use it while deploying or
            fixing data so nobody submits into a half-working app.
          </p>
        </div>

        {loading && <p className="muted">Loading…</p>}

        {!loading && (
          <>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20,
                padding: '12px 14px', borderRadius: 8,
                background: isOn ? 'rgba(180,83,9,0.08)' : 'rgba(16,185,129,0.08)',
                border: `1px solid ${isOn ? 'rgba(180,83,9,0.3)' : 'rgba(16,185,129,0.3)'}`
              }}
            >
              <span
                style={{
                  width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                  background: isOn ? '#b45309' : '#10b981'
                }}
              />
              <strong style={{ fontSize: 14, color: isOn ? '#92400e' : '#065f46' }}>
                {degraded
                  ? 'Unknown — the switch could not be read'
                  : isOn ? 'Maintenance is ON' : 'Maintenance is OFF'}
              </strong>
              {isOn && state?.until && (
                <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                  says back by {new Date(state.until).toLocaleString('en-US', {
                    hour: 'numeric', minute: '2-digit'
                  })}
                </span>
              )}
            </div>

            {degraded && (
              <p className="muted" style={{ fontSize: 12, marginBottom: 16, color: '#b45309' }}>
                Because the switch could not be read, the portal is behaving as if
                maintenance is off. Reload, or check again after saving.
              </p>
            )}

            <div className="field">
              <label>What BAMs will see</label>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                rows={3}
                maxLength={MAX_MESSAGE_LENGTH}
                placeholder={DEFAULT_MESSAGE}
                style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5 }}
              />
              <span className="muted" style={{ fontSize: 11 }}>
                Leave blank to use: “{DEFAULT_MESSAGE}”
              </span>
            </div>

            <div className="field" style={{ maxWidth: 220 }}>
              <label>Back in (minutes, optional)</label>
              <input
                type="number"
                min={1}
                value={minutes}
                onChange={e => setMinutes(e.target.value)}
                placeholder="5"
              />
              <span className="muted" style={{ fontSize: 11 }}>
                Shown as a time, so it does not go stale. It does not switch maintenance
                off on its own.
              </span>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              {isOn ? (
                <button onClick={() => save(false)} disabled={busy}>
                  {busy ? 'Saving…' : 'Turn maintenance OFF'}
                </button>
              ) : (
                <button onClick={() => save(true)} disabled={busy}>
                  {busy ? 'Saving…' : 'Turn maintenance ON'}
                </button>
              )}
              {isOn && (
                <button className="btn-ghost" onClick={() => save(true)} disabled={busy}>
                  Update the message
                </button>
              )}
              <button className="btn-ghost" onClick={load} disabled={busy} style={{ marginLeft: 'auto' }}>
                Refresh
              </button>
            </div>

            {notice && (
              <p
                style={{
                  marginTop: 16, marginBottom: 0, fontSize: 13, lineHeight: 1.6,
                  color: notice.kind === 'ok' ? '#065f46' : '#991b1b'
                }}
              >
                {notice.text}
              </p>
            )}

            <p className="muted" style={{ fontSize: 12, marginTop: 24, lineHeight: 1.6 }}>
              Never blocked, so you cannot lock yourself out: the sign-in page, every
              /admin page, and anyone with an admin role. To see what BAMs see, open the
              portal in a private window.
            </p>
          </>
        )}
      </div>
    </>
  )
}
