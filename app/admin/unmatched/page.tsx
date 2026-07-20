import { TopBar } from '../_components/TopBar'

export default function Unmatched() {
  return (
    <>
      <TopBar crumbs={['Roster', 'Unmatched onboarding']} />

      <div className="surface">
        <div className="surface-header">
          <div>
            <div className="surface-title">Unmatched submissions</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Students whose email didn&rsquo;t match the pending roster. Usually an email typo &mdash; fix the roster row and re-match, or reject.
            </div>
          </div>
          <span className="badge badge-teal">PII-safe view</span>
        </div>

        <div className="muted" style={{ fontSize: 12, padding: '8px 0 16px' }}>
          <strong>Privacy:</strong> banking fields are never stored for unmatched submissions. Only the email + non-sensitive fields are shown here.
        </div>

        <div className="empty-state">No unmatched submissions.</div>
      </div>
    </>
  )
}
