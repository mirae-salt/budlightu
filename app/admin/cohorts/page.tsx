import { TopBar } from '../_components/TopBar'

export default function Cohorts() {
  return (
    <>
      <TopBar crumbs={['Roster', 'Cohorts']} />

      <div className="surface">
        <div className="surface-header">
          <div>
            <div className="surface-title">Program cohorts</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Each intake = one cohort. PO number, program label, salary defaults, and send mode live here.
            </div>
          </div>
          <button>+ New cohort</button>
        </div>

        <div className="empty-state">
          No cohorts yet. Create the first one to load the fall 2026 roster.
        </div>
      </div>
    </>
  )
}
