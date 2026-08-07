'use client'
/**
 * /admin/banking-requests — Robin's queue for BAM banking corrections.
 *
 * The whole point of this screen is that approving is NOT a reflex click. The
 * current and requested values sit side by side so a change is readable at a
 * glance, and the approve button stays locked until the reviewer retypes the
 * requested account number. The server checks that again; the disabled button is
 * only a hint.
 */
import { useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'

type Values = {
  bank_name: string | null
  institution_no: string | null
  transit_no: string | null
  account_no: string | null
}

type PendingRow = {
  id: string
  bam_id: string
  bam_name: string
  bam_email: string | null
  reason: string
  requested_at: string
  current: Values
  requested: Values
  expected_institution_no: string | null
  institution_mismatch: boolean
  read_error: string | null
  current_read_error: string | null
}

type DecidedRow = {
  id: string
  bam_name: string
  status: string
  requested_at: string
  decided_at: string | null
  decision_note: string | null
  requested_bank_name: string
}

function fmt(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const mono: React.CSSProperties = { fontFamily: 'monospace', fontSize: 14, letterSpacing: '0.04em' }

function Field({ label, before, after }: { label: string; before: string | null; after: string | null }) {
  const changed = (before ?? '') !== (after ?? '')
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--midgray)', padding: '6px 0' }}>{label}</div>
      <div style={{ ...mono, padding: '6px 0', color: 'var(--midgray)' }}>
        {before ?? <span style={{ fontFamily: 'inherit', fontStyle: 'italic' }}>not readable</span>}
      </div>
      <div style={{
        ...mono, padding: '6px 8px', borderRadius: 6,
        fontWeight: changed ? 700 : 400,
        color: 'var(--bl-navy)',
        background: changed ? 'var(--yellow-tint)' : 'transparent'
      }}>
        {after ?? <span style={{ fontFamily: 'inherit', fontStyle: 'italic' }}>not readable</span>}
      </div>
    </>
  )
}

export default function BankingRequestsPage() {
  const [pending, setPending] = useState<PendingRow[]>([])
  const [decided, setDecided] = useState<DecidedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [openId, setOpenId] = useState<string | null>(null)
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null)
  const [confirmAccount, setConfirmAccount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/banking-requests')
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setLoadError(json.message ?? 'Could not load the queue.')
      } else {
        setLoadError(null)
        setPending(json.pending ?? [])
        setDecided(json.decided ?? [])
      }
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function openPanel(row: PendingRow, next: 'approve' | 'reject') {
    setOpenId(row.id)
    setMode(next)
    setConfirmAccount('')
    setNote('')
    setRowError(null)
  }

  async function decide(row: PendingRow, decision: 'approved' | 'rejected') {
    setBusy(true)
    setRowError(null)
    try {
      const res = await fetch('/api/admin/banking-requests/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: row.id,
          decision,
          confirm_account: confirmAccount,
          note
        })
      })
      const json = await res.json()
      if (!res.ok || !json.ok) { setRowError(json.message ?? 'The action failed.'); return }
      setOpenId(null)
      setMode(null)
      setMessage(
        decision === 'approved'
          ? `Applied for ${row.bam_name}. They must confirm the new last 4 digits at next sign in.`
          : `Request from ${row.bam_name} was rejected.`
      )
      setTimeout(() => setMessage(null), 8000)
      await load()
    } catch (e) {
      setRowError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <TopBar crumbs={['Roster', 'Banking changes']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Banking change requests</div>
          <span className={pending.length > 0 ? 'badge badge-yellow' : 'badge badge-green'}>
            {pending.length} pending
          </span>
        </div>

        {message && (
          <div className="badge badge-green" style={{ marginBottom: 16, display: 'inline-block' }}>{message}</div>
        )}
        {loadError && (
          <div className="badge badge-red" style={{ marginBottom: 16, display: 'inline-block' }}>{loadError}</div>
        )}

        <p style={{ fontSize: 13, color: 'var(--midgray)', lineHeight: 1.7, marginTop: 0 }}>
          A BAM cannot change their own banking. They ask, you apply. Read the requested account number
          against the current one before you approve: if a student&rsquo;s account was taken over, this
          queue is where the payment would be redirected. Applying resets their account confirmation, so
          they have to sign in and confirm the new last 4 digits.
        </p>

        {loading && <div className="empty-state">Loading...</div>}

        {!loading && pending.length === 0 && (
          <div className="empty-state">No banking changes waiting.</div>
        )}

        {pending.map(row => (
          <div key={row.id} className="card" style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--bl-navy)' }}>{row.bam_name}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{row.bam_email ?? 'no email on file'}</div>
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>Requested {fmt(row.requested_at)}</div>
            </div>

            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 8,
              background: 'var(--bl-silver)', fontSize: 13, lineHeight: 1.6
            }}>
              <strong>Their reason:</strong> {row.reason}
            </div>

            {row.read_error && (
              <div className="badge badge-red" style={{ marginTop: 10, display: 'inline-block' }}>{row.read_error}</div>
            )}
            {row.current_read_error && (
              <div className="badge badge-red" style={{ marginTop: 10, display: 'inline-block' }}>{row.current_read_error}</div>
            )}

            <div style={{
              marginTop: 14,
              display: 'grid', gridTemplateColumns: 'minmax(90px, 140px) 1fr 1fr',
              gap: '0 12px', alignItems: 'center'
            }}>
              <div />
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--midgray)', fontWeight: 700 }}>
                On file now
              </div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--bl-navy)', fontWeight: 700 }}>
                Requested
              </div>

              <Field label="Bank" before={row.current.bank_name} after={row.requested.bank_name} />
              <Field label="Institution" before={row.current.institution_no} after={row.requested.institution_no} />
              <Field label="Transit" before={row.current.transit_no} after={row.requested.transit_no} />
              <Field label="Account" before={row.current.account_no} after={row.requested.account_no} />
            </div>

            {row.institution_mismatch && (
              <div style={{
                marginTop: 10, padding: '10px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.6,
                background: 'var(--yellow-tint)', color: '#8B4A00'
              }}>
                The institution number does not match our lookup for {row.requested.bank_name}
                {row.expected_institution_no ? ` (we expect ${row.expected_institution_no})` : ''}.
                The number on the void cheque wins, so this is a flag, not a block. Ask them to send a photo
                of the void cheque if you are not sure.
              </div>
            )}

            {openId !== row.id && (
              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <button onClick={() => openPanel(row, 'approve')}>Approve and apply</button>
                <button
                  className="btn-ghost"
                  style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
                  onClick={() => openPanel(row, 'reject')}
                >
                  Reject
                </button>
              </div>
            )}

            {openId === row.id && mode === 'approve' && (
              <div style={{
                marginTop: 14, padding: 14, borderRadius: 10,
                border: '1px solid rgba(163,18,18,0.25)', background: 'rgba(163,18,18,0.05)'
              }}>
                <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                  <strong style={{ color: '#A31212' }}>This sends real money to a new account.</strong>{' '}
                  Type the requested account number below to confirm you have read it. Approving writes it
                  to {row.bam_name}&rsquo;s record and clears their account confirmation.
                </div>
                <div className="field" style={{ marginTop: 12, marginBottom: 10 }}>
                  <label htmlFor={`confirm-${row.id}`}>Retype the requested account number</label>
                  <input
                    id={`confirm-${row.id}`}
                    value={confirmAccount}
                    autoComplete="off"
                    onChange={e => setConfirmAccount(e.target.value)}
                    style={mono}
                    placeholder="Type it, do not paste"
                  />
                  {confirmAccount !== '' && confirmAccount !== (row.requested.account_no ?? ' ') && (
                    <span className="field-err">Does not match the requested account number yet.</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    disabled={busy || row.requested.account_no === null || confirmAccount !== row.requested.account_no}
                    onClick={() => decide(row, 'approved')}
                  >
                    {busy ? 'Applying...' : 'Confirm and apply'}
                  </button>
                  <button className="btn-ghost" onClick={() => { setOpenId(null); setMode(null) }}>Cancel</button>
                </div>
                {rowError && <p style={{ color: '#A31212', fontSize: 13, marginBottom: 0 }}>{rowError}</p>}
              </div>
            )}

            {openId === row.id && mode === 'reject' && (
              <div style={{
                marginTop: 14, padding: 14, borderRadius: 10,
                border: '1px solid var(--stone)', background: 'var(--bl-silver)'
              }}>
                <div className="field" style={{ marginBottom: 10 }}>
                  <label htmlFor={`note-${row.id}`}>Why are you rejecting this? The BAM sees this note.</label>
                  <textarea id={`note-${row.id}`} rows={3} value={note} onChange={e => setNote(e.target.value)} />
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    style={{ background: 'var(--red)' }}
                    disabled={busy || note.trim().length < 5}
                    onClick={() => decide(row, 'rejected')}
                  >
                    {busy ? 'Saving...' : 'Confirm reject'}
                  </button>
                  <button className="btn-ghost" onClick={() => { setOpenId(null); setMode(null) }}>Cancel</button>
                </div>
                {rowError && <p style={{ color: '#A31212', fontSize: 13, marginBottom: 0 }}>{rowError}</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="surface" style={{ marginTop: 20 }}>
        <div className="surface-header">
          <div className="surface-title">Decided</div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr><th>BAM</th><th>Requested</th><th>Decided</th><th>Result</th><th>Note</th></tr>
            </thead>
            <tbody>
              {decided.map(d => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 600 }}>{d.bam_name}</td>
                  <td className="muted">{fmt(d.requested_at)}</td>
                  <td className="muted">{fmt(d.decided_at)}</td>
                  <td>
                    <span className={d.status === 'applied' ? 'badge badge-green' : 'badge badge-red'}>
                      {d.status}
                    </span>
                  </td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{d.decision_note ?? ''}</td>
                </tr>
              ))}
              {decided.length === 0 && (
                <tr><td colSpan={5}><div className="empty-state">Nothing decided yet.</div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
