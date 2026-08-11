// Admin team management — add/remove admin users
'use client'

import { useState, useEffect, useCallback } from 'react'
import { TopBar } from '../_components/TopBar'

type AdminUser = {
  id: string
  email: string
  first_name: string
  last_name: string
  role: 'super_admin' | 'program_admin'
  created_at: string
}

export default function TeamPage() {
  const [admins, setAdmins] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<{ email: string; first_name: string; last_name: string; role: 'program_admin' | 'super_admin' }>({ email: '', first_name: '', last_name: '', role: 'program_admin' })
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/admin/team')
      const data = await res.json()
      // A failed request used to leave `admins` at [], which renders "No admin users
      // configured yet" — unknown displayed as none. On this page that reads as
      // "nobody has access", which is the opposite of what a failure means.
      if (data.ok) setAdmins(data.admins ?? [])
      else setLoadError(data.message || 'Could not load the admin list.')
    } catch {
      setLoadError('Could not reach the server to load the admin list.')
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function handleAdd() {
    if (!form.email.includes('@') || !form.first_name.trim()) return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      })
      const data = await res.json()
      if (data.ok) {
        // A partial success (role granted, but the test BAM account or audit row
        // failed) arrives as `warning`. It used to be dropped, so the admin was
        // told "Added" either way. Show it, and leave it up long enough to read.
        setToast(
          data.warning
            ? `Added ${form.first_name}, but: ${data.warning}`
            : `Added ${form.first_name} as ${form.role === 'super_admin' ? 'Super Admin' : 'Program Admin'} (with a test BAM account for the student portal)`
        )
        setShowAdd(false)
        setForm({ email: '', first_name: '', last_name: '', role: 'program_admin' })
        load()
      } else {
        setToast(data.message || 'Failed to add admin')
      }
      setBusy(false)
      setTimeout(() => setToast(null), data.warning ? 15000 : 5000)
      return
    } catch {
      setToast('Network error')
    }
    setBusy(false)
    setTimeout(() => setToast(null), 5000)
  }

  async function handleRemove(admin: AdminUser) {
    if (!confirm(`Remove ${admin.first_name} ${admin.last_name} (${admin.email}) from admin team?`)) return
    const res = await fetch('/api/admin/team', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: admin.id })
    })
    const data = await res.json()
    setToast(
      data.ok
        ? (data.warning ? `Removed ${admin.first_name}, but: ${data.warning}` : `Removed ${admin.first_name}`)
        : (data.message || 'Failed')
    )
    if (data.ok) load()
    setTimeout(() => setToast(null), data.warning ? 15000 : 5000)
  }

  return (
    <>
      <TopBar crumbs={['System', 'Admin Team']} />
      <div className="surface">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 4 }}>
              Admin Team
            </h2>
            <p className="muted" style={{ fontSize: 13 }}>
              Manage who has access to the admin dashboard.
            </p>
          </div>
          <button onClick={() => setShowAdd(!showAdd)} style={{ whiteSpace: 'nowrap' }}>
            {showAdd ? 'Cancel' : '+ Add admin'}
          </button>
        </div>

        {showAdd && (
          <div style={{
            padding: 20, border: '1px solid var(--border)', borderRadius: 10,
            marginBottom: 20, background: 'var(--bl-silver)'
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <label>First name</label>
                <input value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} placeholder="First name" />
              </div>
              <div className="field">
                <label>Last name</label>
                <input value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} placeholder="Last name" />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
              <div className="field">
                <label>Email</label>
                <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="name@ilovesalt.com" />
              </div>
              <div className="field">
                <label>Role</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as 'super_admin' | 'program_admin' }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, background: '#fff' }}>
                  <option value="program_admin">Program Admin</option>
                  <option value="super_admin">Super Admin</option>
                </select>
              </div>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--midgray)', lineHeight: 1.6 }}>
              <strong>Program Admin:</strong> Can review receipts, approve invoices, manage BAMs.{' '}
              <strong>Super Admin:</strong> Full access including system settings and team management.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={handleAdd} disabled={busy || !form.email.includes('@') || !form.first_name.trim()}>
                {busy ? 'Adding...' : 'Add to team'}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="muted" style={{ padding: 20, textAlign: 'center' }}>Loading...</p>
        ) : admins.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--midgray)', fontSize: 14 }}>
            {loadError
              ? `We could not load the admin list: ${loadError} This does not mean the list is empty.`
              : 'No admin users configured yet. Add your first admin above.'}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Added</th>
                  <th style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {admins.map(a => (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 600 }}>{a.first_name} {a.last_name}</td>
                    <td>{a.email}</td>
                    <td>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                        fontSize: 11, fontWeight: 600,
                        background: a.role === 'super_admin' ? 'rgba(0,115,207,0.1)' : 'rgba(128,128,128,0.1)',
                        color: a.role === 'super_admin' ? '#0073cf' : '#6b7280'
                      }}>
                        {a.role === 'super_admin' ? 'Super Admin' : 'Program Admin'}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {a.created_at ? new Date(a.created_at).toLocaleDateString('en-CA') : ''}
                    </td>
                    <td>
                      <button
                        onClick={() => handleRemove(a)}
                        style={{
                          fontSize: 12, padding: '4px 10px', background: 'transparent',
                          border: '1px solid var(--border)', color: 'var(--midgray)', borderRadius: 6
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {toast && (
          <div style={{
            position: 'fixed', bottom: 24, right: 24, padding: '10px 18px',
            background: 'var(--bl-navy)', color: '#fff', borderRadius: 8,
            fontSize: 13, fontWeight: 600, zIndex: 999, boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
          }}>
            {toast}
          </div>
        )}
      </div>
    </>
  )
}
