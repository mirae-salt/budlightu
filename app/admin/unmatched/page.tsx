'use client'

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { Toast } from '../_components/Toast'
import { UNMATCHED, type UnmatchedRow } from '../_lib/dummy'
import { rosterEmailFromFlagReason } from '@/lib/unmatched-resolve'

type Row = UnmatchedRow & { id: string; rosterEmail: string | null }

type DbSubmission = {
  id: string
  submitted_email: string
  submitted_at: string
  flag_reason: string | null
  form_json_meta: { match_guess?: string } | null
}

function mapDbSubmission(s: DbSubmission): Row {
  return {
    id: s.id,
    submittedEmail: s.submitted_email,
    submittedAt: new Date(s.submitted_at).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }),
    reason: s.flag_reason || 'no matching roster email',
    // The roster address the submission failed to match. This is what identifies
    // the target roster row, so show it instead of a guess nothing writes.
    matchGuess: rosterEmailFromFlagReason(s.flag_reason) || s.form_json_meta?.match_guess || 'unknown',
    rosterEmail: rosterEmailFromFlagReason(s.flag_reason)
  }
}

type Notice = { kind: 'ok' | 'error'; text: string }

export default function Unmatched() {
  const [rows, setRows] = useState<Row[]>([])
  const [useDb, setUseDb] = useState(false)
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [correctedEmail, setCorrectedEmail] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    fetch('/api/admin/data?table=unmatched')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setRows((data as DbSubmission[]).map(mapDbSubmission))
          setUseDb(true)
        } else {
          setRows(UNMATCHED.map((u, i) => ({ ...u, id: `dummy-${i}`, rosterEmail: null })))
        }
      })
      .catch(() => {
        setRows(UNMATCHED.map((u, i) => ({ ...u, id: `dummy-${i}`, rosterEmail: null })))
      })
  }, [])

  /** Notices stay until replaced when they are failures: a red flash that
   *  disappears is how the old unconditional green went unnoticed. */
  function report(n: Notice) {
    setNotice(n)
    if (n.kind === 'ok') setTimeout(() => setNotice(cur => (cur === n ? null : cur)), 6000)
  }

  function startFix(row: Row) {
    setFixingId(row.id)
    setRejectingId(null)
    // The address the student actually typed is the one that goes on the roster.
    setCorrectedEmail(row.submittedEmail)
  }

  async function confirmFix(row: Row) {
    if (!useDb) {
      report({ kind: 'error', text: 'This is demo data, so there is nothing to correct. Sign in as an admin to load real submissions.' })
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/admin/unmatched/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submission_id: row.id, corrected_email: correctedEmail })
      })
      const j = await res.json()
      if (!res.ok || !j.ok) {
        report({ kind: 'error', text: `Not resolved: ${j.message || res.statusText}` })
        return
      }
      // Only now is the work actually done, so only now does the row leave.
      setRows(list => list.filter(r => r.id !== row.id))
      setFixingId(null)
      report({ kind: 'ok', text: j.warning ? `${j.message} (${j.warning})` : j.message })
    } catch (e) {
      report({ kind: 'error', text: `Not resolved: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  function startReject(row: Row) {
    setRejectingId(row.id)
    setFixingId(null)
    setRejectReason('')
  }

  async function confirmReject(row: Row) {
    if (!useDb) {
      report({ kind: 'error', text: 'This is demo data, so there is nothing to reject. Sign in as an admin to load real submissions.' })
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/admin/unmatched/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submission_id: row.id, reason: rejectReason })
      })
      const j = await res.json()
      if (!res.ok || !j.ok) {
        report({ kind: 'error', text: `Not rejected: ${j.message || res.statusText}` })
        return
      }
      setRows(list => list.filter(r => r.id !== row.id))
      setRejectingId(null)
      report({ kind: 'ok', text: j.warning ? `${j.message} (${j.warning})` : j.message })
    } catch (e) {
      report({ kind: 'error', text: `Not rejected: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <TopBar crumbs={['Roster', 'Unmatched onboarding']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">
            Unmatched submissions
          </div>
          <span className="badge badge-yellow">{rows.length} pending</span>
        </div>

      {/* Fixed toast: an inline badge beside the button was too easy to miss. */}
      <Toast notice={notice} onDismiss={() => setNotice(null)} />

        <table className="admin-table">
          <thead>
            <tr>
              <th>Submitted email</th><th>Submitted at</th><th>Reason</th><th>Roster email</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <Fragment key={u.id}>
                <tr>
                  <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{u.submittedEmail}</td>
                  <td className="muted">{u.submittedAt}</td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{u.reason}</td>
                  <td style={{ fontFamily: 'monospace', color: 'var(--bl-navy)' }}>{u.matchGuess}</td>
                  <td>
                    <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12, marginRight: 4 }} onClick={() => startFix(u)}>Fix roster</button>
                    <button
                      className="btn-ghost"
                      style={{ padding: '4px 8px', fontSize: 12, color: 'var(--red)', borderColor: 'var(--red)' }}
                      onClick={() => startReject(u)}
                    >
                      Reject
                    </button>
                  </td>
                </tr>

                {fixingId === u.id && (
                  <tr>
                    <td colSpan={5} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      <div className="card" style={{ maxWidth: 480 }}>
                        <div className="field">
                          <label>Email to store on the roster</label>
                          <input
                            value={correctedEmail}
                            onChange={e => setCorrectedEmail(e.target.value)}
                          />
                          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
                            The roster row for <strong>{u.rosterEmail ?? 'this submission'}</strong> gets this address,
                            so the student&apos;s existing invite link starts working. Leave it as the address they typed
                            unless you know the roster address is the correct one.
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => confirmFix(u)} disabled={busy || !correctedEmail.trim()}>
                            {busy ? 'Saving...' : 'Save match'}
                          </button>
                          <button className="btn-ghost" onClick={() => setFixingId(null)}>Cancel</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}

                {rejectingId === u.id && (
                  <tr>
                    <td colSpan={5} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      <div className="card" style={{ maxWidth: 480 }}>
                        <div style={{ marginBottom: 10, fontSize: 13 }}>
                          Reject the submission from <strong>{u.submittedEmail}</strong>? This cannot be undone.
                        </div>
                        <div className="field">
                          <label>Reason (recorded on the submission)</label>
                          <input
                            value={rejectReason}
                            onChange={e => setRejectReason(e.target.value)}
                            placeholder="e.g. not a BAM in this cohort"
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            style={{ background: 'var(--red)' }}
                            disabled={busy || rejectReason.trim().length < 4}
                            onClick={() => confirmReject(u)}
                          >
                            {busy ? 'Rejecting...' : 'Confirm reject'}
                          </button>
                          <button className="btn-ghost" onClick={() => setRejectingId(null)}>Cancel</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">No unmatched submissions.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
