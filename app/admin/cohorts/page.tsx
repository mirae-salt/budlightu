'use client'

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { COHORTS, BAMS, type CohortRow } from '../_lib/dummy'

type Row = CohortRow & { id: string | null; bamCopyMode: 'off' | 'draft' | 'live' }

type DbCohort = {
  id: string
  name: string
  program_label: string
  po_number: string | null
  start_date: string
  end_date: string
  send_mode: 'dryrun' | 'live'
  bam_copy_mode: 'off' | 'draft' | 'live'
}

function monthsLabel(start: string, end: string): string {
  const s = new Date(start).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  const e = new Date(end).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  return `${s} — ${e}`
}

type NewCohortForm = {
  name: string
  label: string
  po: string
  start: string
  end: string
}

const EMPTY_FORM: NewCohortForm = { name: '', label: '', po: '', start: '', end: '' }

type BamSummary = { name: string; status: string; email: string }

export default function Cohorts() {
  const [cohorts, setCohorts] = useState<Row[]>([])
  const [useDb, setUseDb] = useState(false)
  const [managingName, setManagingName] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<NewCohortForm>(EMPTY_FORM)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [bamsByCohort, setBamsByCohort] = useState<Record<string, BamSummary[]>>({})

  useEffect(() => {
    fetch('/api/admin/data?table=cohorts')
      .then(res => res.json())
      .then(({ data }) => {
        if (!data || data.length === 0) {
          setCohorts(COHORTS.map(c => ({ ...c, id: null, bamCopyMode: 'draft' as const })))
          return
        }
        const rows: Row[] = (data as (DbCohort & { bam_count: number })[]).map(c => {
          const ended = new Date(c.end_date) < new Date()
          return {
            id: c.id,
            name: c.name,
            label: c.program_label,
            po: c.po_number || '—',
            months: monthsLabel(c.start_date, c.end_date),
            bams: c.bam_count ?? 0,
            sendMode: c.send_mode,
            bamCopyMode: c.bam_copy_mode,
            status: ended ? 'ended' : 'active'
          }
        })
        setCohorts(rows)
        setUseDb(true)
      })
      .catch(() => {
        setCohorts(COHORTS.map(c => ({ ...c, id: null, bamCopyMode: 'draft' as const })))
      })

    const grouped: Record<string, BamSummary[]> = {}
    BAMS.forEach(b => {
      if (!grouped[b.cohort]) grouped[b.cohort] = []
      grouped[b.cohort].push({ name: b.name, status: b.status, email: b.email })
    })
    setBamsByCohort(grouped)
  }, [])

  function toggleManage(name: string) {
    setManagingName(managingName === name ? null : name)
    setCreating(false)
  }

  function updateCohort(name: string, patch: Partial<Row>) {
    setCohorts(list => list.map(c => c.name === name ? { ...c, ...patch } : c))
    setSaveMsg('Saved (local only)')
    setTimeout(() => setSaveMsg(null), 3000)
  }

  function addCohort() {
    if (!form.name.trim() || !form.po.trim()) return
    setCohorts(list => [
      ...list,
      {
        id: null,
        name: form.name,
        label: form.label || form.name,
        po: form.po,
        months: form.start && form.end ? monthsLabel(form.start, form.end) : '—',
        bams: 0,
        sendMode: 'dryrun',
        bamCopyMode: 'draft',
        status: 'active'
      }
    ])
    setForm(EMPTY_FORM)
    setCreating(false)
  }

  return (
    <>
      <TopBar crumbs={['Roster', 'Cohorts']} />

      {saveMsg && (
        <div className="badge badge-green" style={{ marginBottom: 12, display: 'inline-block' }}>{saveMsg}</div>
      )}

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Program cohorts</div>
          <button onClick={() => { setCreating(c => !c); setManagingName(null) }}>
            {creating ? 'Cancel' : '+ New cohort'}
          </button>
        </div>

        {creating && (
          <div className="card" style={{ marginBottom: 16, maxWidth: 520 }}>
            <div className="field">
              <label>Cohort name</label>
              <input placeholder="e.g. Winter 2027" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="field">
              <label>Program label</label>
              <input placeholder="e.g. BL Campus" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
            </div>
            <div className="field">
              <label>PO#</label>
              <input placeholder="e.g. 250437" value={form.po} onChange={e => setForm(f => ({ ...f, po: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Start date</label>
                <input type="date" value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value }))} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>End date</label>
                <input type="date" value={form.end} onChange={e => setForm(f => ({ ...f, end: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={addCohort} disabled={!form.name.trim() || !form.po.trim()}>Create cohort</button>
              <button className="btn-ghost" onClick={() => { setCreating(false); setForm(EMPTY_FORM) }}>Cancel</button>
            </div>
          </div>
        )}

        <table className="admin-table">
          <thead>
            <tr>
              <th>Cohort</th><th>Program label</th><th>PO#</th><th>Months</th><th>BAMs</th><th>Send mode</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map(c => {
              const members = bamsByCohort[c.name] || []
              const activeCount = members.filter(m => m.status === 'active').length
              const pendingCount = members.filter(m => m.status === 'pending').length
              return (
                <Fragment key={c.name}>
                  <tr>
                    <td style={{ fontWeight: 600, color: 'var(--bl-navy)' }}>{c.name}</td>
                    <td>{c.label}</td>
                    <td style={{ fontFamily: 'monospace' }}>{c.po}</td>
                    <td className="muted">{c.months}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{c.bams || members.length}</td>
                    <td>
                      {c.sendMode === 'dryrun'
                        ? <span className="badge badge-yellow">DRYRUN</span>
                        : <span className="badge badge-green">LIVE</span>}
                    </td>
                    <td>
                      {c.status === 'active'
                        ? <span className="badge badge-blue">ACTIVE</span>
                        : <span className="badge" style={{ background: 'var(--stone-lt)', color: 'var(--slate)' }}>ENDED</span>}
                    </td>
                    <td>
                      <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => toggleManage(c.name)}>
                        {managingName === c.name ? 'Close' : 'Manage'}
                      </button>
                    </td>
                  </tr>

                  {managingName === c.name && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--bl-silver)', padding: 20 }}>
                        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                          {/* Settings panel */}
                          <div className="card" style={{ flex: '1 1 320px', maxWidth: 420 }}>
                            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: 'var(--bl-navy)' }}>Settings</div>

                            <div style={{ display: 'flex', gap: 12 }}>
                              <div className="field" style={{ flex: 1 }}>
                                <label>Program label</label>
                                <input
                                  value={c.label}
                                  onChange={e => updateCohort(c.name, { label: e.target.value })}
                                />
                              </div>
                              <div className="field" style={{ flex: 1 }}>
                                <label>PO#</label>
                                <input
                                  value={c.po}
                                  onChange={e => updateCohort(c.name, { po: e.target.value })}
                                />
                              </div>
                            </div>

                            <div className="field">
                              <label>Send mode</label>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  className={c.sendMode === 'dryrun' ? 'btn-navy' : 'btn-ghost'}
                                  style={{ flex: 1, fontSize: 12 }}
                                  onClick={() => updateCohort(c.name, { sendMode: 'dryrun' })}
                                >
                                  Dryrun
                                </button>
                                <button
                                  className={c.sendMode === 'live' ? 'btn-navy' : 'btn-ghost'}
                                  style={{ flex: 1, fontSize: 12, background: c.sendMode === 'live' ? 'var(--green)' : undefined }}
                                  onClick={() => updateCohort(c.name, { sendMode: 'live' })}
                                >
                                  Live
                                </button>
                              </div>
                              <span className="muted" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
                                {c.sendMode === 'dryrun' ? 'AP emails will NOT be sent — preview only' : 'AP emails WILL be sent to accounts.payable'}
                              </span>
                            </div>

                            <div className="field">
                              <label>BAM copy mode</label>
                              <div style={{ display: 'flex', gap: 6 }}>
                                {(['off', 'draft', 'live'] as const).map(m => (
                                  <button
                                    key={m}
                                    className={c.bamCopyMode === m ? 'btn-navy' : 'btn-ghost'}
                                    style={{ flex: 1, fontSize: 12 }}
                                    onClick={() => updateCohort(c.name, { bamCopyMode: m })}
                                  >
                                    {m === 'off' ? 'Off' : m === 'draft' ? 'Draft' : 'Live'}
                                  </button>
                                ))}
                              </div>
                              <span className="muted" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
                                {c.bamCopyMode === 'off' ? 'BAMs will NOT receive invoice copies'
                                  : c.bamCopyMode === 'draft' ? 'Invoice copies logged but NOT emailed to BAMs'
                                  : 'Invoice copies WILL be emailed to each BAM'}
                              </span>
                            </div>
                          </div>

                          {/* Members panel */}
                          <div className="card" style={{ flex: '1 1 320px', maxWidth: 480 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--bl-navy)' }}>
                                Members ({members.length})
                              </div>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <span className="badge badge-green" style={{ fontSize: 10 }}>ACTIVE {activeCount}</span>
                                {pendingCount > 0 && <span className="badge badge-yellow" style={{ fontSize: 10 }}>PENDING {pendingCount}</span>}
                              </div>
                            </div>

                            {members.length === 0 ? (
                              <div className="muted" style={{ fontSize: 13, padding: '12px 0' }}>
                                No BAMs assigned to this cohort yet. Assign via Roster &gt; Edit.
                              </div>
                            ) : (
                              <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr style={{ borderBottom: '1px solid var(--stone)' }}>
                                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: 'var(--slate)' }}>Name</th>
                                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: 'var(--slate)' }}>Email</th>
                                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: 'var(--slate)' }}>Status</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {members.map(m => (
                                      <tr key={m.email} style={{ borderBottom: '1px solid var(--bl-fog)' }}>
                                        <td style={{ padding: '6px 8px', fontWeight: 500 }}>{m.name}</td>
                                        <td style={{ padding: '6px 8px', color: 'var(--midgray)' }}>{m.email}</td>
                                        <td style={{ padding: '6px 8px' }}>
                                          {m.status === 'active'
                                            ? <span className="badge badge-green" style={{ fontSize: 10 }}>ACTIVE</span>
                                            : m.status === 'pending'
                                            ? <span className="badge badge-yellow" style={{ fontSize: 10 }}>PENDING</span>
                                            : <span className="badge badge-red" style={{ fontSize: 10 }}>ARCHIVED</span>}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {cohorts.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <div className="empty-state">No cohorts configured yet.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
