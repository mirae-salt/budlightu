'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TopBar } from './_components/TopBar'
import { KpiCell } from './_components/StatCard'
import { LineChartPlaceholder } from './_components/LineChartPlaceholder'
import { DASHBOARD_STATS } from './_lib/dummy'

type BamSpending = {
  bam_id: string; cohort_id?: string; name: string; email: string; cohort: string
  monthly: Record<string, number>; totalSpent: number; avgMonthly: number
  lowMonths: number; consecutiveLow: number; isLowPerformer: boolean
  warningCount?: number; warningsSent?: number; warningPeriods?: string[]
  needsReevaluation?: boolean
}

const FAKE_BAM_SPENDING: BamSpending[] = [
  { bam_id: 'f1', cohort_id: 'c1', name: 'Anastacia Tran',  email: 'anastacia.tran@utoronto.ca', cohort: 'Fall 2026', monthly: { '2026-09': 148.50, '2026-10': 142.30 }, totalSpent: 290.80, avgMonthly: 145.40, lowMonths: 0, consecutiveLow: 0, isLowPerformer: false, warningCount: 0, warningsSent: 0, warningPeriods: [], needsReevaluation: false },
  { bam_id: 'f2', cohort_id: 'c1', name: 'Kira Sabharwal',  email: 'kira.s@queensu.ca',          cohort: 'Fall 2026', monthly: { '2026-09': 150.00, '2026-10': 149.80 }, totalSpent: 299.80, avgMonthly: 149.90, lowMonths: 0, consecutiveLow: 0, isLowPerformer: false, warningCount: 0, warningsSent: 0, warningPeriods: [], needsReevaluation: false },
  { bam_id: 'f3', cohort_id: 'c1', name: 'Lucas Grabowski', email: 'lucas.g13@gmail.com',        cohort: 'Fall 2026', monthly: { '2026-09': 132.00, '2026-10': 88.50 },  totalSpent: 220.50, avgMonthly: 110.25, lowMonths: 1, consecutiveLow: 1, isLowPerformer: false, warningCount: 1, warningsSent: 1, warningPeriods: ['2026-10'], needsReevaluation: false },
  { bam_id: 'f4', cohort_id: 'c1', name: 'Luke Grabowski',  email: 'luke.grabowski@yorku.ca',    cohort: 'Fall 2026', monthly: { '2026-09': 145.60, '2026-10': 150.00 }, totalSpent: 295.60, avgMonthly: 147.80, lowMonths: 0, consecutiveLow: 0, isLowPerformer: false, warningCount: 0, warningsSent: 0, warningPeriods: [], needsReevaluation: false },
  { bam_id: 'f5', cohort_id: 'c1', name: 'Luke Ducheck',    email: 'lducheck@uwo.ca',            cohort: 'Fall 2026', monthly: { '2026-09': 78.20, '2026-10': 45.00 },   totalSpent: 123.20, avgMonthly: 61.60,  lowMonths: 2, consecutiveLow: 2, isLowPerformer: true, warningCount: 2, warningsSent: 2, warningPeriods: ['2026-09', '2026-10'], needsReevaluation: true },
  { bam_id: 'f6', cohort_id: 'c1', name: 'Emma Chen',       email: 'emma.chen@dal.ca',           cohort: 'Fall 2026', monthly: { '2026-09': 150.00, '2026-10': 138.90 }, totalSpent: 288.90, avgMonthly: 144.45, lowMonths: 0, consecutiveLow: 0, isLowPerformer: false, warningCount: 0, warningsSent: 0, warningPeriods: [], needsReevaluation: false },
  { bam_id: 'f7', cohort_id: 'c1', name: 'Avery Wong',      email: 'avery.w@ucalgary.ca',        cohort: 'Fall 2026', monthly: { '2026-09': 110.50, '2026-10': 125.40 }, totalSpent: 235.90, avgMonthly: 117.95, lowMonths: 1, consecutiveLow: 0, isLowPerformer: false, warningCount: 1, warningsSent: 0, warningPeriods: ['2026-09'], needsReevaluation: false },
  { bam_id: 'f8', cohort_id: 'c1', name: 'Ian Sullivan',    email: 'ian.sullivan@mtroyal.ca',    cohort: 'Fall 2026', monthly: { '2026-09': 143.70, '2026-10': 150.00 }, totalSpent: 293.70, avgMonthly: 146.85, lowMonths: 0, consecutiveLow: 0, isLowPerformer: false, warningCount: 0, warningsSent: 0, warningPeriods: [], needsReevaluation: false },
  { bam_id: 'f9', cohort_id: 'c1', name: 'Sophia Martin',   email: 'smartin@uottawa.ca',         cohort: 'Fall 2026', monthly: { '2026-09': 95.30, '2026-10': 112.80 },  totalSpent: 208.10, avgMonthly: 104.05, lowMonths: 1, consecutiveLow: 0, isLowPerformer: false, warningCount: 1, warningsSent: 1, warningPeriods: ['2026-09'], needsReevaluation: false },
  { bam_id: 'f10', cohort_id: 'c1', name: 'Devon Park',     email: 'devon.park@uwaterloo.ca',    cohort: 'Fall 2026', monthly: { '2026-09': 62.40, '2026-10': 0 },       totalSpent: 62.40,  avgMonthly: 31.20,  lowMonths: 2, consecutiveLow: 2, isLowPerformer: true, warningCount: 2, warningsSent: 2, warningPeriods: ['2026-09', '2026-10'], needsReevaluation: true },
  { bam_id: 'f11', cohort_id: 'c1', name: 'Marcus Rivera',  email: 'marcus.r@torontomu.ca',      cohort: 'Fall 2026', monthly: { '2026-09': 138.90, '2026-10': 144.50 }, totalSpent: 283.40, avgMonthly: 141.70, lowMonths: 0, consecutiveLow: 0, isLowPerformer: false, warningCount: 0, warningsSent: 0, warningPeriods: [], needsReevaluation: false },
  { bam_id: 'f12', cohort_id: 'c1', name: 'Nadia Fischer',  email: 'nadia.f@smu.ca',             cohort: 'Fall 2026', monthly: { '2026-09': 150.00, '2026-10': 147.20 }, totalSpent: 297.20, avgMonthly: 148.60, lowMonths: 0, consecutiveLow: 0, isLowPerformer: false, warningCount: 0, warningsSent: 0, warningPeriods: [], needsReevaluation: false },
]

function currentPeriod(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

function BamSpendingSection({ bamSpending, spendingView, setSpendingView }: {
  bamSpending: BamSpending[]; spendingView: 'low' | 'all'; setSpendingView: (v: 'low' | 'all') => void
}) {
  const [expandedBam, setExpandedBam] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const CAP_PER_MONTH = 150

  const enriched = bamSpending.map(b => {
    const monthCount = Object.keys(b.monthly).length
    const cap = CAP_PER_MONTH * monthCount
    const remaining = Math.max(0, cap - b.totalSpent)
    const utilization = cap > 0 ? (b.totalSpent / cap) * 100 : 0
    return { ...b, monthCount, cap, remaining, utilization }
  })

  const totals = enriched.reduce((acc, b) => ({
    cap: acc.cap + b.cap, spent: acc.spent + b.totalSpent, remaining: acc.remaining + b.remaining
  }), { cap: 0, spent: 0, remaining: 0 })

  const filtered = search
    ? enriched.filter(b => b.name.toLowerCase().includes(search.toLowerCase()) || b.cohort.toLowerCase().includes(search.toLowerCase()))
    : enriched

  const list = spendingView === 'low'
    ? filtered.filter(b => b.monthCount > 0 && (b.utilization < 85 || b.consecutiveLow >= 2)).sort((a, b) => a.utilization - b.utilization)
    : [...filtered].sort((a, b) => a.name.localeCompare(b.name))

  const flaggedCount = enriched.filter(b => b.isLowPerformer).length

  return (
    <div className="surface">
      <div className="surface-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="surface-title">BAM spending</span>
          {flaggedCount > 0 && <span className="badge badge-red">{flaggedCount} flagged</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Filter by name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 160, padding: '5px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)' }}
          />
          <div className="chart-tabs">
            <button className={`chart-tab${spendingView === 'low' ? ' active' : ''}`} onClick={() => setSpendingView('low')}>
              Under budget
            </button>
            <button className={`chart-tab${spendingView === 'all' ? ' active' : ''}`} onClick={() => setSpendingView('all')}>
              All BAMs
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
        <div style={{ background: 'var(--stone-lt, #f5f5f0)', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ fontSize: 12, color: 'var(--midgray)', marginBottom: 4 }}>Total budget</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--bl-navy)', fontVariantNumeric: 'tabular-nums' }}>
            ${totals.cap.toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: 'var(--midgray)' }}>${CAP_PER_MONTH}/mo × {enriched.length} BAMs</div>
        </div>
        <div style={{ background: 'var(--stone-lt, #f5f5f0)', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ fontSize: 12, color: 'var(--midgray)', marginBottom: 4 }}>Total spent</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--bl-blue, #0088CE)', fontVariantNumeric: 'tabular-nums' }}>
            ${Math.round(totals.spent).toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: 'var(--midgray)' }}>{totals.cap > 0 ? Math.round((totals.spent / totals.cap) * 100) : 0}% of budget</div>
        </div>
        <div style={{ background: 'var(--stone-lt, #f5f5f0)', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ fontSize: 12, color: 'var(--midgray)', marginBottom: 4 }}>Remaining</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--bl-navy)', fontVariantNumeric: 'tabular-nums' }}>
            ${Math.round(totals.remaining).toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: 'var(--midgray)' }}>across {enriched.length} BAMs</div>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="empty-state" style={{ padding: 40 }}>
          {spendingView === 'low'
            ? 'All BAMs are spending on track. No one under 85% utilization.'
            : 'No spending data available yet. Data populates after receipts are processed.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '180px 80px 1fr 90px 90px 80px 80px', gap: 8, padding: '0 8px 6px', fontSize: 11, fontWeight: 600, color: 'var(--midgray)', textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>
            <span>BAM</span>
            <span>Active</span>
            <span>Budget usage</span>
            <span style={{ textAlign: 'right' }}>Cap</span>
            <span style={{ textAlign: 'right' }}>Spent</span>
            <span style={{ textAlign: 'right' }}>Left</span>
            <span style={{ textAlign: 'center' }}>Status</span>
          </div>
          {list.map(b => {
            const pct = Math.min(b.utilization, 100)
            const isLow = b.utilization < 70
            const isMid = b.utilization >= 70 && b.utilization < 85
            const barColor = isLow ? 'var(--red, #ef4444)' : isMid ? 'var(--amber, #f59e0b)' : 'var(--bl-blue, #0088CE)'
            const expanded = expandedBam === b.bam_id
            const months = Object.entries(b.monthly).sort(([a], [c]) => a.localeCompare(c))

            return (
              <div key={b.bam_id}>
                <div
                  onClick={() => setExpandedBam(expanded ? null : b.bam_id)}
                  style={{
                    display: 'grid', gridTemplateColumns: '180px 80px 1fr 90px 90px 80px 80px', gap: 8,
                    alignItems: 'center', padding: '8px', borderRadius: 6, cursor: 'pointer',
                    background: expanded ? 'rgba(0,136,206,0.04)' : 'transparent',
                    transition: 'background 0.15s'
                  }}
                  onMouseEnter={e => { if (!expanded) (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,0,0,0.02)' }}
                  onMouseLeave={e => { if (!expanded) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                      background: isLow ? 'rgba(239,68,68,0.1)' : 'rgba(0,136,206,0.1)',
                      color: isLow ? 'var(--red, #ef4444)' : 'var(--bl-blue, #0088CE)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 700
                    }}>
                      {b.name.split(' ').map(w => w[0]).join('')}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--midgray)' }}>{b.cohort}</div>
                    </div>
                  </div>

                  <div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--slate, #64748b)' }}>
                    {b.monthCount} mo
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 4,
                        width: `${Math.max(pct, 3)}%`,
                        background: barColor,
                        transition: 'width 0.4s ease'
                      }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: barColor, fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'right' }}>
                      {Math.round(b.utilization)}%
                    </span>
                  </div>

                  <div style={{ textAlign: 'right', fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--midgray)' }}>
                    ${b.cap.toLocaleString()}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--bl-navy)' }}>
                    ${Math.round(b.totalSpent).toLocaleString()}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 13, fontVariantNumeric: 'tabular-nums', color: b.remaining < 50 ? 'var(--red, #ef4444)' : 'var(--slate, #64748b)' }}>
                    ${Math.round(b.remaining).toLocaleString()}
                  </div>

                  <div style={{ textAlign: 'center' }}>
                    {b.needsReevaluation
                      ? <span className="badge badge-red" style={{ fontSize: 10 }}>2x warn</span>
                      : (b.warningCount ?? 0) > 0
                        ? <span className="badge badge-yellow" style={{ fontSize: 10 }}>1x warn</span>
                        : b.isLowPerformer
                          ? <span className="badge badge-red" style={{ fontSize: 10 }}>low</span>
                          : b.consecutiveLow >= 2
                            ? <span className="badge badge-yellow" style={{ fontSize: 10 }}>watch</span>
                            : <span className="badge badge-green" style={{ fontSize: 10 }}>OK</span>}
                  </div>
                </div>

                {expanded && months.length > 0 && (
                  <div style={{ padding: '4px 8px 12px 52px' }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: (b.warningCount ?? 0) > 0 || b.utilization < 85 ? 10 : 0 }}>
                      {months.map(([m, v]) => (
                        <div key={m} style={{
                          padding: '4px 10px', borderRadius: 6, fontSize: 12, fontVariantNumeric: 'tabular-nums',
                          background: v < 130 ? 'rgba(239,68,68,0.08)' : 'rgba(0,136,206,0.06)',
                          color: v < 130 ? 'var(--red, #ef4444)' : 'var(--bl-navy)',
                          border: `1px solid ${v < 130 ? 'rgba(239,68,68,0.15)' : 'rgba(0,136,206,0.1)'}`
                        }}>
                          <span style={{ fontWeight: 600 }}>
                            {new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' })}
                          </span>
                          {' '}${Math.round(v)}
                          {(b.warningPeriods ?? []).includes(m) && <span title="Warning sent" style={{ marginLeft: 4 }}>&#9888;</span>}
                        </div>
                      ))}
                    </div>
                    {((b.warningCount ?? 0) > 0 || b.utilization < 85) && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--midgray)' }}>
                        {(b.warningCount ?? 0) > 0 && (
                          <span style={{
                            padding: '2px 8px', borderRadius: 4, fontWeight: 600,
                            background: b.needsReevaluation ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                            color: b.needsReevaluation ? '#DC2626' : '#D97706',
                          }}>
                            {b.warningCount} warning{(b.warningCount ?? 0) !== 1 ? 's' : ''} ({b.warningsSent ?? 0} sent)
                            {b.needsReevaluation && ' · reevaluate'}
                          </span>
                        )}
                        <button
                          className="btn-navy"
                          style={{ fontSize: 11, padding: '3px 10px' }}
                          onClick={async e => {
                            e.stopPropagation()
                            const lowestMonth = months.reduce((min, [m, v]) => v < (min[1] as number) ? [m, v] : min, months[0])
                            const btn = e.currentTarget
                            btn.disabled = true
                            btn.textContent = 'Sending...'
                            try {
                              const res = await fetch('/api/admin/warnings', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  bam_id: b.bam_id, cohort_id: b.cohort_id,
                                  period: lowestMonth[0], spent: lowestMonth[1], action: 'flag'
                                })
                              })
                              const data = await res.json()
                              if (data.ok) {
                                btn.textContent = data.skipped ? 'Already flagged' : 'Robin notified'
                                btn.style.background = 'var(--green, #22c55e)'
                              } else {
                                btn.textContent = data.message || 'Failed'
                                btn.style.background = 'var(--red, #ef4444)'
                              }
                            } catch {
                              btn.textContent = 'Network error'
                              btn.style.background = 'var(--red, #ef4444)'
                            }
                            setTimeout(() => { btn.disabled = false; btn.textContent = 'Flag & notify Robin'; btn.style.background = '' }, 3000)
                          }}
                        >
                          Flag & notify Robin
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ReceiptStatusSummary() {
  const statuses = [
    { label: 'Auto-approved', count: 28, color: '#0088CE', pct: 48 },
    { label: 'Manually approved', count: 12, color: '#059669', pct: 21 },
    { label: 'Pending review', count: 9, color: '#D97706', pct: 16 },
    { label: 'Rejected', count: 5, color: '#DC2626', pct: 9 },
    { label: 'OCR failed', count: 4, color: '#6B7280', pct: 7 },
  ]
  const total = statuses.reduce((a, s) => a + s.count, 0)

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--bl-navy)' }}>{total}</span>
        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>receipts</span>
      </div>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 16 }}>
        {statuses.map(s => (
          <div key={s.label} style={{ width: `${s.pct}%`, background: s.color }} title={`${s.label}: ${s.count}`} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {statuses.map(s => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
              <span style={{ color: 'var(--bl-navy)' }}>{s.label}</span>
            </div>
            <div style={{ display: 'flex', gap: 12, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontWeight: 600, color: 'var(--bl-navy)' }}>{s.count}</span>
              <span className="muted" style={{ width: 36, textAlign: 'right' }}>{s.pct}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function BarChartPlaceholder({ data }: { data?: Record<string, number> }) {
  const entries = data ? Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).slice(-12) : []
  const hasReal = entries.length > 0
  const fallback = [12, 18, 24, 16, 22, 30, 26, 34, 28, 38, 42, 36]
  const bars = hasReal ? entries.map(([, v]) => v) : fallback
  const labels = hasReal
    ? entries.map(([m]) => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' }))
    : null
  const max = Math.max(...bars, 1)
  return (
    <div>
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
      {labels && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--midgray)', marginTop: 4 }}>
          {labels.map((l, i) => <span key={i}>{l}</span>)}
        </div>
      )}
    </div>
  )
}

export default function AdminDashboard() {
  const [s, setS] = useState(DASHBOARD_STATS)
  const [chartTab, setChartTab] = useState('30 Days')
  const [reimbByMonth, setReimbByMonth] = useState<Record<string, number>>({})
  const [invoicesByMonth, setInvoicesByMonth] = useState<Record<string, number>>({})
  const [bamSpending, setBamSpending] = useState<BamSpending[]>([])
  const [spendingView, setSpendingView] = useState<'low' | 'all'>('low')
  const router = useRouter()

  useEffect(() => {
    const period = currentPeriod()
    fetch(`/api/admin/data?table=dashboard&period=${period}`)
      .then(res => res.json())
      .then(({ data }) => {
        if (!data) return
        const { activeBams, pendingBams, receiptsSubmitted, reviewQueue, invoicesSent, invoicesByMonth: ibm, reimbByMonth: rbm } = data
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
        if (ibm) setInvoicesByMonth(ibm)
        if (rbm) setReimbByMonth(rbm)
      })
      .catch(() => {})

    fetch('/api/admin/data?table=bam_spending')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0 && data.some((b: BamSpending) => Object.keys(b.monthly).length >= 2))
          setBamSpending(data)
        else setBamSpending(FAKE_BAM_SPENDING)
      })
      .catch(() => setBamSpending(FAKE_BAM_SPENDING))
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

        <LineChartPlaceholder data={Object.keys(reimbByMonth).length > 0 ? reimbByMonth : undefined} />
      </div>

      <div className="grid-2">
        <div className="surface" style={{ marginBottom: 0 }}>
          <div className="surface-header">
            <div className="surface-title">Invoice volume</div>
            <button className="btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} disabled title="Data placeholder">Monthly ▾</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--bl-navy)' }}>0</span>
            <span className="badge badge-blue" style={{ marginLeft: 8 }}>first cycle</span>
          </div>
          <BarChartPlaceholder data={invoicesByMonth} />
        </div>

        <div className="surface" style={{ marginBottom: 0 }}>
          <div className="surface-header">
            <div className="surface-title">Receipt status</div>
            <span className="muted" style={{ fontSize: 12 }}>this month</span>
          </div>
          <ReceiptStatusSummary />
        </div>
      </div>

      <BamSpendingSection bamSpending={bamSpending} spendingView={spendingView} setSpendingView={setSpendingView} />
    </>
  )
}
