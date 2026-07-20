import { TopBar } from '../_components/TopBar'

export default function Roster() {
  return (
    <>
      <TopBar crumbs={['Roster', 'BAMs']} />

      <div className="surface">
        <div className="surface-header">
          <div>
            <div className="surface-title">BAM roster</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Add, edit, or archive BAMs. New entries start as <em>pending</em> until they complete onboarding.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="badge badge-green">ACTIVE · 0</span>
            <span className="badge badge-yellow">PENDING · 0</span>
            <span className="badge badge-red">ARCHIVED · 0</span>
          </div>
        </div>

        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>Cohort</th><th>Status</th><th>Invite</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan={5}><div className="empty-state" style={{ margin: 0 }}>No BAMs loaded. Add them via cohort setup.</div></td></tr>
          </tbody>
        </table>
      </div>
    </>
  )
}
