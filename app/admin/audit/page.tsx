import { TopBar } from '../_components/TopBar'

export default function AuditLog() {
  return (
    <>
      <TopBar crumbs={['System', 'Audit log']} />

      <div className="surface">
        <div className="surface-header">
          <div>
            <div className="surface-title">Audit log</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Every write action on money- or PII-adjacent tables. Read-only, super-admin only.
            </div>
          </div>
          <button className="btn-ghost">Export CSV</button>
        </div>

        <div className="empty-state">Empty log — no activity yet.</div>
      </div>
    </>
  )
}
