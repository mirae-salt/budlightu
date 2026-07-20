import { TopBar } from './_components/TopBar'
import { KpiCell } from './_components/StatCard'
import { LineChartPlaceholder } from './_components/LineChartPlaceholder'
import { HeatmapPlaceholder } from './_components/Heatmap'

export default function AdminDashboard() {
  return (
    <>
      <TopBar crumbs={['Dashboard', 'Overview']} />

      {/* Hero KPI surface */}
      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Program summary</div>
          <button className="btn-teal">View details ↗</button>
        </div>
        <div className="kpi-row">
          <KpiCell label="Active BAMs"       value="58"       delta="0.9%" trend="up" />
          <KpiCell label="Receipts this period" value="42"    delta="3.4%" trend="down" />
          <KpiCell label="Review queue"      value="6"        hint="Robin action" trend="neutral" />
          <KpiCell label="Budget used"       value="$3.2K"    delta="2.5%" trend="up" />
          <KpiCell label="Invoices sent"     value="0"        hint="cycle: Sept 16" />
        </div>
      </div>

      {/* Main chart */}
      <div className="surface">
        <div className="surface-header">
          <div>
            <div className="chart-headline">Monthly reimbursement <span className="badge-teal badge">accumulate</span></div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Total paid across cohort per period, incl. carryover.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="chart-tabs">
              <button className="chart-tab">Today</button>
              <button className="chart-tab">7 Days</button>
              <button className="chart-tab active">30 Days</button>
              <button className="chart-tab">12 Months</button>
              <button className="chart-tab">All Time</button>
            </div>
            <button className="btn-ghost" style={{ padding: '7px 12px' }}>Refresh</button>
          </div>
        </div>

        <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--ink)', letterSpacing: '-0.02em', marginBottom: 4 }}>
          72% <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--midgray)' }}>of monthly cap</span>
        </div>
        <div className="trend-up" style={{ fontSize: 12, fontWeight: 600, marginBottom: 16 }}>▲ 0.9% vs last period</div>

        <LineChartPlaceholder />
      </div>

      {/* Bottom grid */}
      <div className="grid-2">
        <div className="surface" style={{ marginBottom: 0 }}>
          <div className="surface-header">
            <div>
              <div className="surface-title">Spending heatmap</div>
              <div className="muted" style={{ fontSize: 12 }}>BAM × month, current cohort</div>
            </div>
            <button className="btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }}>Monthly ▾</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 24, fontWeight: 700 }}>120</span>
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>Records &middot; usage frequency over cohort</span>
          </div>
          <HeatmapPlaceholder />
        </div>

        <div className="surface" style={{ marginBottom: 0 }}>
          <div className="surface-header">
            <div>
              <div className="surface-title">Invoice volume</div>
              <div className="muted" style={{ fontSize: 12 }}>Sent to AP per month</div>
            </div>
            <button className="btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }}>Monthly ▾</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 24, fontWeight: 700 }}>0</span>
            <span className="badge badge-teal" style={{ marginLeft: 8 }}>first cycle</span>
            <div className="muted" style={{ fontSize: 12 }}>Cycle starts Sept 16</div>
          </div>
          <BarChartPlaceholder />
        </div>
      </div>
    </>
  )
}

function BarChartPlaceholder() {
  const bars = [12, 18, 24, 16, 22, 30, 26, 34, 28, 38, 42, 36]
  const max = Math.max(...bars)
  return (
    <div style={{ height: 180, display: 'flex', alignItems: 'flex-end', gap: 8, padding: '10px 0' }}>
      {bars.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${(v / max) * 100}%`,
            background: i === bars.length - 1 ? 'var(--teal-sub)' : 'var(--teal-tint)',
            borderRadius: '6px 6px 0 0',
            minHeight: 4
          }}
          title={`${v} invoices`}
        />
      ))}
    </div>
  )
}
