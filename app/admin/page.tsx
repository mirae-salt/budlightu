'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TopBar } from './_components/TopBar'
import { KpiCell } from './_components/StatCard'
import { LineChartPlaceholder } from './_components/LineChartPlaceholder'
import { HeatmapPlaceholder } from './_components/Heatmap'
import { DASHBOARD_STATS } from './_lib/dummy'

function currentPeriod(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export default function AdminDashboard() {
  const [s, setS] = useState(DASHBOARD_STATS)
  const [chartTab, setChartTab] = useState('30 Days')
  const router = useRouter()

  useEffect(() => {
    const period = currentPeriod()
    fetch(`/api/admin/data?table=dashboard&period=${period}`)
      .then(res => res.json())
      .then(({ data }) => {
        if (!data) return
        const { activeBams, pendingBams, receiptsSubmitted, reviewQueue, invoicesSent } = data
        const anyLive = [activeBams, receiptsSubmitted, reviewQueue, invoicesSent].some((c: number) => c > 0)
        if (!anyLive) return

        setS(prev => ({
          ...prev,
          activeBams: activeBams || prev.activeBams,
          receiptsSubmitted: receiptsSubmitted || prev.receiptsSubmitted,
          missingReceipts: activeBams > 0 ? Math.max(0, activeBams - receiptsSubmitted) : prev.missingReceipts,
          reviewQueue: reviewQueue ?? prev.reviewQueue,
          invoicesSent: invoicesSent ?? prev.invoicesSent,
          pendingOnboarding: pendingBams ?? prev.pendingOnboarding
        }))
      })
      .catch(() => {})
  }, [])
  return (
    <>
      <TopBar crumbs={['Dashboard', 'Overview']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Program summary</div>
          <button className="btn-navy" onClick={() => router.push('/admin/roster')}>View details ↗</button>
        </div>
        <div className="kpi-row">
          <KpiCell label="Active BAMs"       value={String(s.activeBams)}        delta="0.9%" trend="up" onClick={() => router.push('/admin/roster')} />
          <KpiCell label="Receipts submitted" value={`${s.receiptsSubmitted} / ${s.activeBams}`} delta={`${s.missingReceipts} missing`} trend={s.missingReceipts > 0 ? 'down' : 'up'} onClick={() => router.push('/admin/receipts')} />
          <KpiCell label="Review queue"      value={String(s.reviewQueue)}       hint="Action needed" trend="neutral" onClick={() => router.push('/admin/receipts')} />
          <KpiCell label="Budget used"       value={s.budgetUsed}                delta="2.5%" trend="up" onClick={() => router.push('/admin/cohorts')} />
          <KpiCell label="Invoices sent"     value={String(s.invoicesSent)}      hint="cycle: Sept 16" onClick={() => router.push('/admin/invoices')} />
          <KpiCell label="Pending onboarding" value={String(s.pendingOnboarding)} hint="need bank info" trend={s.pendingOnboarding > 0 ? 'down' : 'up'} onClick={() => router.push('/admin/roster')} />
        </div>
      </div>

      <div className="surface">
        <div className="surface-header">
          <div className="chart-headline">Monthly reimbursement <span className="badge-blue badge">accumulate</span></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="chart-tabs">
              {['Today', '7 Days', '30 Days', '12 Months', 'All Time'].map(t => (
                <button key={t} className={`chart-tab${chartTab === t ? ' active' : ''}`} onClick={() => setChartTab(t)}>{t}</button>
              ))}
            </div>
            <button className="btn-ghost" style={{ padding: '7px 12px' }} onClick={() => window.location.reload()}>Refresh</button>
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
            <button className="btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} disabled title="Data placeholder">Monthly ▾</button>
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
            <button className="btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} disabled title="Data placeholder">Monthly ▾</button>
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
            background: i === bars.length - 1 ? 'var(--bl-blue)' : 'rgba(58,173,217,0.18)',
            borderRadius: '6px 6px 0 0',
            minHeight: 4
          }}
          title={`${v} invoices`}
        />
      ))}
    </div>
  )
}
