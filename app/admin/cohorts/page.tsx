'use client'

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { COHORTS, BAMS, type CohortRow } from '../_lib/dummy'

type Row = CohortRow & { id: string | null; bamCopyMode: 'off' | 'draft' | 'live'; startDate: string; endDate: string }

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
  return `${s} to ${e}`
}

type NewCohortForm = {
  name: string
  label: string
  po: string
  start: string
  end: string
}

const EMPTY_FORM: NewCohortForm = { name: '', label: '', po: '', start: '', end: '' }

type BamSummary = { id: string; name: string; status: string; email: string }

export default function Cohorts() {
  const [cohorts, setCohorts] = useState<Row[]>([])
  const [useDb, setUseDb] = useState(false)
  const [managingId, setManagingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<NewCohortForm>(EMPTY_FORM)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [bamsByCohort, setBamsByCohort] = useState<Record<string, BamSummary[]>>({})
  const [allBams, setAllBams] = useState<BamSummary[]>([])
  const [addingBam, setAddingBam] = useState(false)

  useEffect(() => {
    fetch('/api/admin/data?table=cohorts')
      .then(res => res.json())
      .then(({ data }) => {
        if (!data || data.length === 0) {
          setCohorts(COHORTS.map(c => ({ ...c, id: null, bamCopyMode: 'draft' as const, startDate: '', endDate: '' })))
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
            startDate: c.start_date,
            endDate: c.end_date,
            status: ended ? 'ended' : 'active'
          }
        })
        setCohorts(rows)
        setUseDb(true)
      })
      .catch(() => {
        setCohorts(COHORTS.map(c => ({ ...c, id: null, bamCopyMode: 'draft' as const, startDate: '', endDate: '' })))
      })

    fetch('/api/admin/data?table=bams')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          const all: BamSummary[] = []
          const grouped: Record<string, BamSummary[]> = {}
          for (const b of data as { id: string; first_name: string; last_name: string; email: string; status: string; cohort_id: string }[]) {
            const summary: BamSummary = { id: b.id, name: `${b.first_name || ''} ${b.last_name || ''}`.trim(), status: b.status, email: b.email }
            all.push({ ...summary, status: b.cohort_id || '' })
            const cid = b.cohort_id
            if (!cid) continue
            if (!grouped[cid]) grouped[cid] = []
            grouped[cid].push(summary)
          }
          setAllBams(data.map((b: { id: string; first_name: string; last_name: string; email: string; status: string; cohort_id: string }) => ({
            id: b.id,
            name: `${b.first_name || ''} ${b.last_name || ''}`.trim(),
            status: b.status,
            email: b.email,
            cohortId: b.cohort_id || null
          })))
          setBamsByCohort(grouped)
        } else {
          const grouped: Record<string, BamSummary[]> = {}
          BAMS.forEach(b => {
            if (!grouped[b.cohort]) grouped[b.cohort] = []
            grouped[b.cohort].push({ id: '', name: b.name, status: b.status, email: b.email })
          })
          setBamsByCohort(grouped)
        }
      })
      .catch(() => {
        const grouped: Record<string, BamSummary[]> = {}
        BAMS.forEach(b => {
          if (!grouped[b.cohort]) grouped[b.cohort] = []
          grouped[b.cohort].push({ id: '', name: b.name, status: b.status, email: b.email })
        })
        setBamsByCohort(grouped)
      })
  }, [])

  function toggleManage(key: string) {
    setManagingId(managingId === key ? null : key)
    setCreating(false)
    setAddingBam(false)
  }

  async function removeBamFromCohort(cohortId: string | null, bamId: string) {
    if (!cohortId || !bamId) return
    const res = await fetch('/api/admin/cohorts/member', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bam_id: bamId })
    })
    const j = await res.json()
    if (j.ok !== false) {
      setBamsByCohort(prev => {
        const updated = { ...prev }
        if (updated[cohortId]) {
          updated[cohortId] = updated[cohortId].filter(b => b.id !== bamId)
        }
        return updated
      })
      setCohorts(list => list.map(c => c.id === cohortId ? { ...c, bams: Math.max(0, c.bams - 1) } : c))
      setSaveMsg('BAM removed from cohort')
    } else {
      setSaveMsg(`Error: ${j.error || j.message}`)
    }
    setTimeout(() => setSaveMsg(null), 3000)
  }

  async function addBamToCohort(cohortId: string, bamId: string) {
    const res = await fetch('/api/admin/cohorts/member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bam_id: bamId, cohort_id: cohortId })
    })
    const j = await res.json()
    if (j.ok !== false) {
      const bam = (allBams as (BamSummary & { cohortId?: string | null })[]).find(b => b.id === bamId)
      if (bam) {
        setBamsByCohort(prev => {
          const updated = { ...prev }
          if (!updated[cohortId]) updated[cohortId] = []
          updated[cohortId] = [...updated[cohortId], { id: bam.id, name: bam.name, status: bam.status, email: bam.email }]
          return updated
        })
        setAllBams(prev => prev.map(b => b.id === bamId ? { ...b, cohortId: cohortId } as typeof b : b))
        setCohorts(list => list.map(c => c.id === cohortId ? { ...c, bams: c.bams + 1 } : c))
      }
      setSaveMsg('BAM added to cohort')
      setAddingBam(false)
    } else {
      setSaveMsg(`Error: ${j.error || j.message}`)
    }
    setTimeout(() => setSaveMsg(null), 3000)
  }

  async function updateCohort(key: string, patch: Partial<Row>) {
    setCohorts(list => list.map(c => (c.id || c.name) === key ? { ...c, ...patch } : c))
    const row = cohorts.find(c => (c.id || c.name) === key)
    if (row?.id) {
      const apiPatch: Record<string, unknown> = { id: row.id }
      if ('name' in patch) apiPatch.name = patch.name
      if ('label' in patch) apiPatch.program_label = patch.label
      if ('po' in patch) apiPatch.po_number = patch.po
      if ('sendMode' in patch) apiPatch.send_mode = patch.sendMode
      if ('bamCopyMode' in patch) apiPatch.bam_copy_mode = patch.bamCopyMode
      if ('startDate' in patch) { apiPatch.start_date = patch.startDate; setCohorts(list => list.map(c2 => (c2.id || c2.name) === key ? { ...c2, months: patch.startDate && c2.endDate ? monthsLabel(patch.startDate, c2.endDate) : c2.months } : c2)) }
      if ('endDate' in patch) { apiPatch.end_date = patch.endDate; setCohorts(list => list.map(c2 => (c2.id || c2.name) === key ? { ...c2, months: c2.startDate && patch.endDate ? monthsLabel(c2.startDate, patch.endDate) : c2.months } : c2)) }
      const res = await fetch('/api/admin/cohorts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(apiPatch) })
      const j = await res.json()
      setSaveMsg(j.ok ? 'Saved' : `Error: ${j.error || j.message}`)
    } else {
      setSaveMsg('Saved (local only, no DB record)')
    }
    setTimeout(() => setSaveMsg(null), 3000)
  }

  async function addCohort() {
    if (!form.name.trim() || !form.po.trim()) return
    const res = await fetch('/api/admin/cohorts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name.trim(),
        program_label: form.label || form.name.trim(),
        po_number: form.po,
        start_date: form.start || null,
        end_date: form.end || null
      })
    })
    const j = await res.json()
    if (j.ok && j.data) {
      const c = j.data
      setCohorts(list => [...list, {
        id: c.id,
        name: c.name,
        label: c.program_label,
        po: c.po_number || '—',
        months: c.start_date && c.end_date ? monthsLabel(c.start_date, c.end_date) : '—',
        bams: 0,
        sendMode: c.send_mode,
        bamCopyMode: c.bam_copy_mode,
        status: 'active',
        startDate: c.start_date || '',
        endDate: c.end_date || ''
      }])
    } else {
      setCohorts(list => [...list, {
        id: null, name: form.name, label: form.label || form.name, po: form.po,
        months: form.start && form.end ? monthsLabel(form.start, form.end) : '—',
        bams: 0, sendMode: 'dryrun', bamCopyMode: 'draft', status: 'active',
        startDate: form.start, endDate: form.end
      }])
      setSaveMsg(j.error ? `DB error: ${j.error}` : 'Saved locally (DB unavailable)')
      setTimeout(() => setSaveMsg(null), 3000)
    }
    setForm(EMPTY_FORM)
    setCreating(false)
  }

  function getUnassignedBams(cohortId: string): (BamSummary & { cohortId?: string | null })[] {
    return (allBams as (BamSummary & { cohortId?: string | null })[]).filter(b => !b.cohortId || b.cohortId === '')
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
          <button onClick={() => { setCreating(c => !c); setManagingId(null) }}>
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
              <input placeholder="e.g. 260351" value={form.po} onChange={e => setForm(f => ({ ...f, po: e.target.value }))} />
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
              <th style={{ whiteSpace: 'nowrap' }}>Cohort</th>
              <th style={{ whiteSpace: 'nowrap' }}>Label</th>
              <th style={{ whiteSpace: 'nowrap' }}>PO#</th>
              <th style={{ whiteSpace: 'nowrap' }}>Months</th>
              <th style={{ whiteSpace: 'nowrap' }}>BAMs</th>
              <th style={{ whiteSpace: 'nowrap' }}>Send</th>
              <th style={{ whiteSpace: 'nowrap' }}>Status</th>
              <th style={{ width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map(c => {
              const cKey = c.id || c.name
              const members = (c.id ? bamsByCohort[c.id] : bamsByCohort[c.name]) || []
              const activeCount = members.filter(m => m.status === 'active').length
              const pendingCount = members.filter(m => m.status === 'pending').length
              const unassigned = c.id ? getUnassignedBams(c.id) : []
              return (
                <Fragment key={cKey}>
                  <tr>
                    <td style={{ fontWeight: 600, color: 'var(--bl-navy)', whiteSpace: 'nowrap' }}>{c.name}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{c.label}</td>
                    <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{c.po}</td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{c.months}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{c.bams || members.length}</td>
                    <td>
                      {c.sendMode === 'dryrun'
                        ? <span className="badge badge-yellow" style={{ whiteSpace: 'nowrap' }}>DRYRUN</span>
                        : <span className="badge badge-green" style={{ whiteSpace: 'nowrap' }}>LIVE</span>}
                    </td>
                    <td>
                      {c.status === 'active'
                        ? <span className="badge badge-blue" style={{ whiteSpace: 'nowrap' }}>ACTIVE</span>
                        : <span className="badge" style={{ background: 'var(--stone-lt)', color: 'var(--slate)', whiteSpace: 'nowrap' }}>ENDED</span>}
                    </td>
                    <td>
                      <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' }} onClick={() => toggleManage(cKey)}>
                        {managingId === cKey ? 'Close' : 'Manage'}
                      </button>
                    </td>
                  </tr>

                  {managingId === cKey && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--bl-silver)', padding: 20 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 400px) 1fr', gap: 20 }}>
                          {/* Settings panel */}
                          <div className="card" style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: 'var(--bl-navy)' }}>Settings</div>

                            <div className="field">
                              <label>Cohort name</label>
                              <input
                                value={c.name}
                                onChange={e => updateCohort(cKey, { name: e.target.value })}
                              />
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                              <div className="field">
                                <label>Program label</label>
                                <input
                                  value={c.label}
                                  onChange={e => updateCohort(cKey, { label: e.target.value })}
                                />
                              </div>
                              <div className="field">
                                <label>PO#</label>
                                <input
                                  value={c.po}
                                  onChange={e => updateCohort(cKey, { po: e.target.value })}
                                />
                              </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                              <div className="field">
                                <label>Start</label>
                                <input type="date" value={c.startDate} onChange={e => updateCohort(cKey, { startDate: e.target.value })} />
                              </div>
                              <div className="field">
                                <label>End</label>
                                <input type="date" value={c.endDate} onChange={e => updateCohort(cKey, { endDate: e.target.value })} />
                              </div>
                            </div>

                            <div style={{ borderTop: '1px solid var(--stone)', paddingTop: 14, marginTop: 8 }}>
                              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: 'var(--bl-navy)' }}>Email delivery</div>

                              <div className="field" style={{ marginBottom: 10 }}>
                                <label style={{ fontSize: 12 }}>AP invoice emails</label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                                  <button
                                    className={c.sendMode === 'dryrun' ? 'btn-navy' : 'btn-ghost'}
                                    style={{ fontSize: 12 }}
                                    onClick={() => updateCohort(cKey, { sendMode: 'dryrun' })}
                                  >
                                    Test mode
                                  </button>
                                  <button
                                    className={c.sendMode === 'live' ? 'btn-navy' : 'btn-ghost'}
                                    style={{ fontSize: 12, background: c.sendMode === 'live' ? 'var(--green)' : undefined }}
                                    onClick={() => updateCohort(cKey, { sendMode: 'live' })}
                                  >
                                    Live
                                  </button>
                                </div>
                                <span className="muted" style={{ fontSize: 11, marginTop: 3, display: 'block' }}>
                                  {c.sendMode === 'dryrun' ? 'Invoices generated but NOT emailed to AP' : 'Invoices WILL be emailed to AP'}
                                </span>
                              </div>

                              <div className="field">
                                <label style={{ fontSize: 12 }}>BAM invoice copies</label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                                  {(['off', 'draft', 'live'] as const).map(m => (
                                    <button
                                      key={m}
                                      className={c.bamCopyMode === m ? 'btn-navy' : 'btn-ghost'}
                                      style={{ fontSize: 12 }}
                                      onClick={() => updateCohort(cKey, { bamCopyMode: m })}
                                    >
                                      {m === 'off' ? 'Off' : m === 'draft' ? 'Log only' : 'Send'}
                                    </button>
                                  ))}
                                </div>
                                <span className="muted" style={{ fontSize: 11, marginTop: 3, display: 'block' }}>
                                  {c.bamCopyMode === 'off' ? 'BAMs don\'t get a copy'
                                    : c.bamCopyMode === 'draft' ? 'Logged but not emailed (test)'
                                    : 'Each BAM gets their invoice emailed'}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Members panel */}
                          <div className="card" style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--bl-navy)' }}>
                                  Members ({members.length})
                                </span>
                                <span className="badge badge-green" style={{ fontSize: 10 }}>{activeCount} active</span>
                                {pendingCount > 0 && <span className="badge badge-yellow" style={{ fontSize: 10 }}>{pendingCount} pending</span>}
                              </div>
                              {c.id && (
                                <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setAddingBam(!addingBam)}>
                                  {addingBam ? 'Cancel' : '+ Add'}
                                </button>
                              )}
                            </div>

                            {addingBam && c.id && (
                              <div style={{ marginBottom: 12, padding: 10, background: 'var(--bl-fog, #f0f0f0)', borderRadius: 6 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Unassigned BAMs</div>
                                {unassigned.length === 0 ? (
                                  <div className="muted" style={{ fontSize: 12 }}>All BAMs are already assigned to a cohort.</div>
                                ) : (
                                  <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                                    {unassigned.map(b => (
                                      <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--stone-lt, #e5e5e5)' }}>
                                        <div>
                                          <span style={{ fontSize: 12, fontWeight: 500 }}>{b.name}</span>
                                          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>{b.email}</span>
                                        </div>
                                        <button style={{ fontSize: 11, padding: '2px 10px' }} onClick={() => addBamToCohort(c.id!, b.id)}>Add</button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {members.length === 0 ? (
                              <div className="muted" style={{ fontSize: 13, padding: '12px 0' }}>
                                No BAMs assigned yet. Click "+ Add" to assign BAMs.
                              </div>
                            ) : (
                              <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr style={{ borderBottom: '1px solid var(--stone)' }}>
                                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: 'var(--slate)', whiteSpace: 'nowrap' }}>Name</th>
                                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: 'var(--slate)', whiteSpace: 'nowrap' }}>Email</th>
                                      <th style={{ textAlign: 'center', padding: '4px 8px', fontWeight: 600, color: 'var(--slate)', width: 70, whiteSpace: 'nowrap' }}>Status</th>
                                      <th style={{ width: 60 }}></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {members.map(m => (
                                      <tr key={m.email} style={{ borderBottom: '1px solid var(--bl-fog)' }}>
                                        <td style={{ padding: '6px 8px', fontWeight: 500, whiteSpace: 'nowrap' }}>{m.name}</td>
                                        <td style={{ padding: '6px 8px', color: 'var(--midgray)', whiteSpace: 'nowrap' }}>{m.email}</td>
                                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                          {m.status === 'active'
                                            ? <span className="badge badge-green" style={{ fontSize: 10 }}>ACTIVE</span>
                                            : m.status === 'pending'
                                            ? <span className="badge badge-yellow" style={{ fontSize: 10 }}>PENDING</span>
                                            : <span className="badge badge-red" style={{ fontSize: 10 }}>ARCHIVED</span>}
                                        </td>
                                        <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                                          {m.id && <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--red, #ef4444)', whiteSpace: 'nowrap' }} onClick={() => { if (confirm(`Remove ${m.name} from this cohort?`)) removeBamFromCohort(c.id, m.id) }}>Remove</button>}
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
