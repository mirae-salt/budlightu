'use client'

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { BAMS, type BamRow } from '../_lib/dummy'
import { BANK_SEED } from '@/lib/banks'

type DbBam = {
  id: string
  first_name: string
  last_name: string
  email: string
  status: 'pending' | 'active' | 'archived'
  bank_name: string | null
  initials_resolved: string | null
  school_id: string | null
  cohorts: { name: string } | null
}

type FullRow = BamRow & { id: string }

function mapDbBam(b: DbBam): FullRow {
  return {
    id: b.id,
    name: `${b.first_name} ${b.last_name}`,
    email: b.email,
    status: b.status,
    bank: b.bank_name || '—',
    invoiceCode: b.initials_resolved ? `INV-${b.initials_resolved}` : null,
    cohort: b.cohorts?.name || '—',
    school: b.school_id || '—'
  }
}

type EditForm = { name: string; email: string; bank: string; status: string; cohort: string }

export default function Roster() {
  const [bams, setBams] = useState<FullRow[]>([])
  const [useDb, setUseDb] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<EditForm>({ name: '', email: '', bank: '', status: '', cohort: '' })
  const [editMsg, setEditMsg] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addForm, setAddForm] = useState({ firstName: '', lastName: '', email: '', school: '', cohort: '' })
  const [cohortList, setCohortList] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/admin/data?table=bams')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setBams((data as DbBam[]).map(mapDbBam))
          setUseDb(true)
        } else {
          setBams(BAMS.map((b, i) => ({ ...b, id: `dummy-${i}` })))
        }
      })
      .catch(() => {
        setBams(BAMS.map((b, i) => ({ ...b, id: `dummy-${i}` })))
      })

    fetch('/api/admin/data?table=cohorts')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setCohortList((data as { name: string }[]).map(c => c.name))
        } else {
          setCohortList(['Fall 2026', 'Summer 2026'])
        }
      })
      .catch(() => setCohortList(['Fall 2026', 'Summer 2026']))
  }, [])

  const rows = bams

  const active   = rows.filter(b => b.status === 'active').length
  const pending  = rows.filter(b => b.status === 'pending').length
  const archived = rows.filter(b => b.status === 'archived').length

  const badgeFor = (s: 'active' | 'pending' | 'archived') =>
      s === 'active'   ? <span className="badge badge-green">ACTIVE</span>
    : s === 'pending'  ? <span className="badge badge-yellow">PENDING</span>
                       : <span className="badge badge-red">ARCHIVED</span>

  function startEdit(b: FullRow) {
    setEditingId(b.id)
    setEditForm({ name: b.name, email: b.email, bank: b.bank, status: b.status, cohort: b.cohort })
    setAdding(false)
  }

  function saveEdit(id: string) {
    setBams(prev => prev.map(b => b.id === id ? {
      ...b,
      name: editForm.name,
      email: editForm.email,
      bank: editForm.bank,
      status: editForm.status as 'active' | 'pending' | 'archived',
      cohort: editForm.cohort
    } : b))
    setEditingId(null)
    setEditMsg('Saved (local only — DB update requires admin auth)')
    setTimeout(() => setEditMsg(null), 4000)
  }

  function addBam() {
    if (!addForm.firstName.trim() || !addForm.email.trim()) return
    const newBam: FullRow = {
      id: `new-${Date.now()}`,
      name: `${addForm.firstName} ${addForm.lastName}`.trim(),
      email: addForm.email,
      status: 'pending',
      bank: '—',
      invoiceCode: null,
      cohort: addForm.cohort || '—',
      school: addForm.school || '—',
    }
    setBams(prev => [...prev, newBam])
    setAddForm({ firstName: '', lastName: '', email: '', school: '', cohort: '' })
    setAdding(false)
    setEditMsg('Added (local only — DB insert requires admin auth)')
    setTimeout(() => setEditMsg(null), 4000)
  }

  return (
    <>
      <TopBar crumbs={['Roster', 'BAMs']} />

      {editMsg && (
        <div className="badge badge-green" style={{ marginBottom: 12, display: 'inline-block' }}>{editMsg}</div>
      )}

      <div className="surface">
        <div className="surface-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="surface-title" style={{ marginRight: 4 }}>BAM roster</span>
            <span className="badge badge-green">ACTIVE · {active}</span>
            <span className="badge badge-yellow">PENDING · {pending}</span>
            <span className="badge badge-red">ARCHIVED · {archived}</span>
          </div>
          <button onClick={() => { setAdding(a => !a); setEditingId(null) }}>
            {adding ? 'Cancel' : '+ Add BAM'}
          </button>
        </div>

        {adding && (
          <div className="card" style={{ marginBottom: 16, maxWidth: 520 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>First name</label>
                <input value={addForm.firstName} onChange={e => setAddForm(f => ({ ...f, firstName: e.target.value }))} placeholder="Robin" />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Last name</label>
                <input value={addForm.lastName} onChange={e => setAddForm(f => ({ ...f, lastName: e.target.value }))} placeholder="Graham" />
              </div>
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={addForm.email} onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))} placeholder="robin@school.edu" />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>School</label>
                <input value={addForm.school} onChange={e => setAddForm(f => ({ ...f, school: e.target.value }))} placeholder="Western" />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Cohort</label>
                <select value={addForm.cohort} onChange={e => setAddForm(f => ({ ...f, cohort: e.target.value }))}>
                  <option value="">Select…</option>
                  {cohortList.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={addBam} disabled={!addForm.firstName.trim() || !addForm.email.trim()}>Add to roster</button>
              <button className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>School</th><th>Cohort</th><th>Bank</th><th>Invoice code</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <Fragment key={b.id}>
                  <tr>
                    <td style={{ fontWeight: 600 }}>{b.name}</td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{b.email}</td>
                    <td className="muted">{b.school}</td>
                    <td className="muted">{b.cohort}</td>
                    <td>{b.bank}</td>
                    <td style={{ fontFamily: 'monospace', color: 'var(--bl-navy)', fontWeight: 600 }}>
                      {b.invoiceCode ?? <span className="muted">—</span>}
                    </td>
                    <td>{badgeFor(b.status)}</td>
                    <td>
                      <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => startEdit(b)}>
                        Edit
                      </button>
                    </td>
                  </tr>

                  {editingId === b.id && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                        <div className="card" style={{ maxWidth: 520 }}>
                          <div style={{ display: 'flex', gap: 12 }}>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Name</label>
                              <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Email</label>
                              <input type="email" value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} />
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 12 }}>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Bank</label>
                              <select value={editForm.bank} onChange={e => setEditForm(f => ({ ...f, bank: e.target.value }))}>
                                <option value="">Select…</option>
                                {BANK_SEED.map(b => <option key={b.normalized} value={b.displayName}>{b.displayName}</option>)}
                              </select>
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Cohort</label>
                              <select value={editForm.cohort} onChange={e => setEditForm(f => ({ ...f, cohort: e.target.value }))}>
                                <option value="">Select…</option>
                                {cohortList.map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 12 }}>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Status</label>
                              <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}>
                                <option value="active">Active</option>
                                <option value="pending">Pending</option>
                                <option value="archived">Archived</option>
                              </select>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => saveEdit(b.id)}>Save</button>
                            <button className="btn-ghost" onClick={() => setEditingId(null)}>Cancel</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">No BAMs found. Sign in as admin to view roster data.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
