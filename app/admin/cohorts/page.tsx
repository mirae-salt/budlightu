import { TopBar } from '../_components/TopBar'
import { COHORTS } from '../_lib/dummy'

export default function Cohorts() {
  return (
    <>
      <TopBar crumbs={['Roster', 'Cohorts']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Program cohorts</div>
          <button>+ New cohort</button>
        </div>

        <table className="admin-table">
          <thead>
            <tr>
              <th>Cohort</th><th>Program label</th><th>PO#</th><th>Months</th><th>BAMs</th><th>Send mode</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {COHORTS.map(c => (
              <tr key={c.name}>
                <td style={{ fontWeight: 600, color: 'var(--bl-navy)' }}>{c.name}</td>
                <td>{c.label}</td>
                <td style={{ fontFamily: 'monospace' }}>{c.po}</td>
                <td className="muted">{c.months}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{c.bams}</td>
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
                  <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}>Manage</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
