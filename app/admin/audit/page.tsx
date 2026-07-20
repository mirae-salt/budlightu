import { TopBar } from '../_components/TopBar'
import { AUDIT_LOG } from '../_lib/dummy'

export default function AuditLog() {
  const roleBadge = (r: 'super_admin' | 'program_admin' | 'system' | 'bam') =>
      r === 'super_admin'   ? <span className="badge badge-navy">SUPER</span>
    : r === 'program_admin' ? <span className="badge badge-blue">ADMIN</span>
    : r === 'system'        ? <span className="badge" style={{ background: 'var(--stone-lt)', color: 'var(--slate)' }}>SYSTEM</span>
                            : <span className="badge badge-green">BAM</span>

  return (
    <>
      <TopBar crumbs={['System', 'Audit log']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Audit log</div>
          <button className="btn-ghost">Export CSV</button>
        </div>

        <table className="admin-table">
          <thead>
            <tr>
              <th>Time</th><th>Actor</th><th>Role</th><th>Entity</th><th>Action</th><th>Target</th>
            </tr>
          </thead>
          <tbody>
            {AUDIT_LOG.map((e, i) => (
              <tr key={i}>
                <td className="muted" style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{e.ts}</td>
                <td style={{ fontWeight: 600 }}>{e.actor}</td>
                <td>{roleBadge(e.role)}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{e.entity}</td>
                <td style={{ fontWeight: 500 }}>{e.action}</td>
                <td className="muted" style={{ fontSize: 12.5 }}>{e.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
