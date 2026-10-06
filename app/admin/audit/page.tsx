'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { type AuditRow } from '../_lib/dummy'
import { entityLabel, actionLabel, roleLabel } from '@/lib/audit-wording'

type RoleFilter = 'all' | AuditRow['role']

const PROD_CUTOFF = new Date('2026-08-28T00:00:00').getTime()

type DbAuditLog = {
  ts: string
  actor_role: string | null
  entity: string
  entity_id: string | null
  action: string
  after_json: unknown
}

function normalizeRole(role: string | null): AuditRow['role'] {
  if (role === 'super_admin' || role === 'program_admin' || role === 'system' || role === 'bam') return role
  return 'system'
}

function mapDbAuditLog(e: DbAuditLog): AuditRow & { isTest: boolean } {
  return {
    ts: new Date(e.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    actor: normalizeRole(e.actor_role) === 'system' ? 'system' : (e.actor_role || 'unknown'),
    role: normalizeRole(e.actor_role),
    entity: e.entity,
    action: e.action,
    target: e.entity_id || (e.after_json ? JSON.stringify(e.after_json) : '—'),
    isTest: new Date(e.ts).getTime() < PROD_CUTOFF
  }
}

export default function AuditLog() {
  const [log, setLog] = useState<(AuditRow & { isTest?: boolean })[]>([])
  const [useDb, setUseDb] = useState(false)
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [entityFilter, setEntityFilter] = useState<string>('all')

  useEffect(() => {
    fetch('/api/admin/data?table=audit')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setLog((data as DbAuditLog[]).map(mapDbAuditLog))
          setUseDb(true)
        } else {
          setLog([])
        }
      })
      .catch(() => {
        setLog([])
      })
  }, [])

  const entities = useMemo(
    () => Array.from(new Set(log.map(e => e.entity))).sort(),
    [log]
  )

  const filtered = log.filter(e =>
    (roleFilter === 'all' || e.role === roleFilter) &&
    (entityFilter === 'all' || e.entity === entityFilter)
  )

  const roleBadge = (r: AuditRow['role']) =>
      r === 'super_admin'   ? <span className="badge badge-navy">SUPER</span>
    : r === 'program_admin' ? <span className="badge badge-blue">ADMIN</span>
    : r === 'system'        ? <span className="badge" style={{ background: 'var(--stone-lt)', color: 'var(--slate)' }}>SYSTEM</span>
                            : <span className="badge badge-green">BAM</span>

  function exportCsv() {
    const header = ['Time', 'Actor', 'Role', 'Entity', 'Action', 'What happened', 'Target']
    const rows = filtered.map(e => [e.ts, e.actor, e.role, e.entity, e.action, actionLabel(e.entity, e.action), e.target])
    const csv = [header, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `blu-audit-log-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <TopBar crumbs={['System', 'Audit log']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">
            Audit log
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as RoleFilter)} style={{ width: 'auto' }}>
              <option value="all">All roles</option>
              <option value="super_admin">{roleLabel('super_admin')}</option>
              <option value="program_admin">{roleLabel('program_admin')}</option>
              <option value="system">{roleLabel('system')}</option>
              <option value="bam">{roleLabel('bam')}</option>
            </select>
            <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)} style={{ width: 'auto' }}>
              <option value="all">All record types</option>
              {entities.map(en => <option key={en} value={en}>{entityLabel(en)}</option>)}
            </select>
            <button className="btn-ghost" onClick={exportCsv}>Export CSV</button>
          </div>
        </div>

        {/* Without this the whole PAGE scrolled sideways below about 900px: measured
            2026-09-18 at 820px, document width 1199 against a 820 viewport. Every
            other admin list confines its overflow to the table; this one did not. */}
        <div className="table-scroll">
        {/* one-line: rows were 52px and 67px depending on whether that entry's actor
            or action happened to wrap. Target keeps wrapping -- it is the one column
            that holds something long enough to be worth reading in full. */}
        <table className="admin-table one-line">
          <thead>
            <tr>
              <th style={{ minWidth: 160 }}>Time</th><th>Actor</th><th>Role</th><th>Record</th><th>What happened</th><th>Target</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e, i) => (
              <tr key={i}>
                <td className="muted" style={{ fontFamily: 'monospace', fontSize: 12.5, whiteSpace: 'nowrap', minWidth: 160 }}>
                  {e.ts}
                  {e.isTest && <span className="badge" style={{ marginLeft: 6, background: 'var(--amber)', color: '#fff', fontSize: 9, padding: '1px 5px' }}>TEST</span>}
                </td>
                <td style={{ fontWeight: 600 }}>{e.actor}</td>
                <td>{roleBadge(e.role)}</td>
                <td title={e.entity}>{entityLabel(e.entity)}</td>
                <td style={{ fontWeight: 500 }} title={`${e.entity} | ${e.action}`}>{actionLabel(e.entity, e.action)}</td>
                <td className="muted wrap" style={{ fontSize: 12.5, maxWidth: 280 }}>
                  <TargetCell value={e.target} />
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">No audit entries match these filters.</div>
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

function TargetCell({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = value.length > 60

  if (!isLong) return <span style={{ wordBreak: 'break-word' }}>{value}</span>

  return (
    <div>
      <span style={{ wordBreak: 'break-word' }}>
        {expanded ? value : value.slice(0, 56) + '…'}
      </span>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          marginLeft: 4, padding: '1px 6px', fontSize: 10, fontWeight: 600,
          background: 'rgba(0,0,0,0.04)', border: '1px solid var(--border)',
          borderRadius: 4, cursor: 'pointer', color: 'var(--bl-blue-ink)',
          whiteSpace: 'nowrap'
        }}
      >
        {expanded ? 'less' : 'more'}
      </button>
    </div>
  )
}
