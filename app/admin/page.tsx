import { TopBar } from './_components/TopBar'
import { KpiCell } from './_components/StatCard'
import { LineChartPlaceholder } from './_components/LineChartPlaceholder'
import { HeatmapPlaceholder } from './_components/Heatmap'
import { DASHBOARD_STATS } from './_lib/dummy'

export default function AdminDashboard() {
  const s = DASHBOARD_STATS
  return (
    <>
      <TopBar crumbs={['Dashboard', 'Overview']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Program summary</div>
          <button className="btn-navy">View details ↗</button>
        </div>
        <div className="kpi-row">
          <KpiCell label="Active BAMs"       value={String(s.activeBams)}      delta="0.9%" trend="up" />
          <KpiCell label="Receipts this period" value={String(s.receiptsSubmitted)} delta="3.4%" trend="down" />
          <KpiCell label="Review queue"      value={String(s.reviewQueue)}     hint="Robin action" trend="neutral" />
          <KpiCell label="Budget used"       value={s.budgetUsed}              delta="2.5%" trend="up" />
          <KpiCell label="Invoices sent"     value={String(s.invoicesSent)}    hint="cycle: Sept 16" />
        </div>
      </div>

      <div className="surface">
        <div className="surface-header">
          <div className="chart-headline">Monthly reimbursement <span className="badge-blue badge">accumulate</span></div>
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

        <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--bl-navy)', letterSpacing: '-0.02em', marginBottom: 4 }}>
          72% <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--midgray)' }}>of monthly cap</span>
        </div>
        <div className="trend-up" style={{ fontSize: 12, fontWeight: 600, marginBottom: 16 }}>▲ 0.9% vs last period</div>

        <LineChartPlaceholder />
      </div>

      <div className="grid-2">
        <div className="surface" style={{ marginBottom: 0 }}>
          <div className="surface-header">
            <div className="surface-title">Spending heatmap</div>
            <button className="btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }}>Monthly ▾</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--bl-navy)' }}>120</span>
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>records</span>
          </div>
          <HeatmapPlaceholder />
        </div>

        <div className="surface" style={{ marginBottom: 0 }}>
          <div className="surface-header">
            <div className="surface-title">Invoice volume</div>
            <button className="btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }}>Monthly ▾</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--bl-navy)' }}>0</span>
            <span className="badge badge-blue" style={{ marginLeft: 8 }}>first cycle</span>
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
            background: i === bars.length - 1 ? 'var(--bl-navy)' : 'var(--bl-sky)',
            borderRadius: '6px 6px 0 0',
            minHeight: 4
          }}
          title={`${v} invoices`}
        />
      ))}
    </div>
  )
}
