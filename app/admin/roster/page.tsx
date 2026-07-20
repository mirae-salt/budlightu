import { TopBar } from '../_components/TopBar'
import { BAMS } from '../_lib/dummy'

export default function Roster() {
  const active   = BAMS.filter(b => b.status === 'active').length
  const pending  = BAMS.filter(b => b.status === 'pending').length
  const archived = BAMS.filter(b => b.status === 'archived').length

  const badgeFor = (s: 'active' | 'pending' | 'archived') =>
      s === 'active'   ? <span className="badge badge-green">ACTIVE</span>
    : s === 'pending'  ? <span className="badge badge-yellow">PENDING</span>
                       : <span className="badge badge-red">ARCHIVED</span>

  return (
    <>
      <TopBar crumbs={['Roster', 'BAMs']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">BAM roster</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="badge badge-green">ACTIVE · {active}</span>
            <span className="badge badge-yellow">PENDING · {pending}</span>
            <span className="badge badge-red">ARCHIVED · {archived}</span>
            <button>+ Add BAM</button>
          </div>
        </div>

        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>School</th><th>Cohort</th><th>Bank</th><th>Invoice code</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {BAMS.map((b, i) => (
              <tr key={i}>
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
                  <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
