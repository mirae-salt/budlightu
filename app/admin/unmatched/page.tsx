import { TopBar } from '../_components/TopBar'
import { UNMATCHED } from '../_lib/dummy'

export default function Unmatched() {
  return (
    <>
      <TopBar crumbs={['Roster', 'Unmatched onboarding']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Unmatched submissions</div>
          <span className="badge badge-yellow">{UNMATCHED.length} pending</span>
        </div>

        <table className="admin-table">
          <thead>
            <tr>
              <th>Submitted email</th><th>Submitted at</th><th>Reason</th><th>Likely match</th><th></th>
            </tr>
          </thead>
          <tbody>
            {UNMATCHED.map((u, i) => (
              <tr key={i}>
                <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{u.submittedEmail}</td>
                <td className="muted">{u.submittedAt}</td>
                <td className="muted" style={{ fontSize: 12.5 }}>{u.reason}</td>
                <td style={{ fontFamily: 'monospace', color: 'var(--bl-navy)' }}>{u.matchGuess}</td>
                <td>
                  <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12, marginRight: 4 }}>Fix roster</button>
                  <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }}>Reject</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
