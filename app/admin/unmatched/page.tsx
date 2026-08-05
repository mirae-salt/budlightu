'use client'

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { UNMATCHED, type UnmatchedRow } from '../_lib/dummy'
import { browserClient } from '@/lib/supabase-browser'

type Row = UnmatchedRow & { id: string }

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
    matchGuess: s.form_json_meta?.match_guess || '—'
  }
}

export default function Unmatched() {
  const [rows, setRows] = useState<Row[]>([])
  const [useDb, setUseDb] = useState(false)
  const [fixingEmail, setFixingEmail] = useState<string | null>(null)
  const [rejectingEmail, setRejectingEmail] = useState<string | null>(null)
  const [correctedEmail, setCorrectedEmail] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/admin/data?table=unmatched')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setRows((data as DbSubmission[]).map(mapDbSubmission))
          setUseDb(true)
        } else {
          setRows(UNMATCHED.map((u, i) => ({ ...u, id: `dummy-${i}` })))
        }
      })
      .catch(() => {
        setRows(UNMATCHED.map((u, i) => ({ ...u, id: `dummy-${i}` })))
      })
  }, [])

  function startFix(row: Row) {
    setFixingEmail(row.submittedEmail)
    setRejectingEmail(null)
    setCorrectedEmail(row.matchGuess.replace('?', ''))
  }

  async function confirmFix(row: Row) {
    if (useDb) {
      const supa = browserClient()
      await supa.from('onboarding_submissions')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() })
        .eq('id', row.id)
    }
    setRows(list => list.filter(r => r.submittedEmail !== row.submittedEmail))
    setFixingEmail(null)
    setMessage('Roster updated')
    setTimeout(() => setMessage(null), 4000)
  }

  function startReject(email: string) {
    setRejectingEmail(email)
    setFixingEmail(null)
  }

  async function confirmReject(row: Row) {
    if (useDb) {
      const supa = browserClient()
      await supa.from('onboarding_submissions')
        .update({ status: 'rejected', resolved_at: new Date().toISOString() })
        .eq('id', row.id)
    }
    setRows(list => list.filter(r => r.submittedEmail !== row.submittedEmail))
    setRejectingEmail(null)
    setMessage('Submission rejected')
    setTimeout(() => setMessage(null), 4000)
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

        {message && (
          <div className="badge badge-green" style={{ marginBottom: 16, display: 'inline-block' }}>{message}</div>
        )}

        <table className="admin-table">
          <thead>
            <tr>
              <th>Submitted email</th><th>Submitted at</th><th>Reason</th><th>Likely match</th><th></th>
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
                      onClick={() => startReject(u.submittedEmail)}
                    >
                      Reject
                    </button>
                  </td>
                </tr>

                {fixingEmail === u.submittedEmail && (
                  <tr>
                    <td colSpan={5} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      <div className="card" style={{ maxWidth: 420 }}>
                        <div className="field">
                          <label>Correct roster email for {u.submittedEmail}</label>
                          <input
                            value={correctedEmail}
                            onChange={e => setCorrectedEmail(e.target.value)}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => confirmFix(u)} disabled={!correctedEmail.trim()}>Save match</button>
                          <button className="btn-ghost" onClick={() => setFixingEmail(null)}>Cancel</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}

                {rejectingEmail === u.submittedEmail && (
                  <tr>
                    <td colSpan={5} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      <div className="card" style={{ maxWidth: 420 }}>
                        <div style={{ marginBottom: 10, fontSize: 13 }}>
                          Confirm reject submission from <strong>{u.submittedEmail}</strong>? This cannot be undone.
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button style={{ background: 'var(--red)' }} onClick={() => confirmReject(u)}>Confirm reject</button>
                          <button className="btn-ghost" onClick={() => setRejectingEmail(null)}>Cancel</button>
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
