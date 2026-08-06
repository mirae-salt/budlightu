'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TopBar } from './_components/TopBar'
import { KpiCell } from './_components/StatCard'
import { LineChartPlaceholder } from './_components/LineChartPlaceholder'
// No dummy imports - all data from DB

type BamSpending = {
  bam_id: string; cohort_id?: string; name: string; email: string; cohort: string
  monthly: Record<string, number>; totalSpent: number; avgMonthly: number
  lowMonths: number; consecutiveLow: number; isLowPerformer: boolean
  warningCount?: number; warningsSent?: number; warningPeriods?: string[]
  needsReevaluation?: boolean
}

const FAKE_BAM_SPENDING: BamSpending[] = [
  { bam_id: 'example-1', cohort_id: 'c1', name: 'Example Student', email: 'example@school.ca', cohort: 'Fall 2026', monthly: { '2026-09': 78.20, '2026-10': 45.00 }, totalSpent: 123.20, avgMonthly: 61.60, lowMonths: 2, consecutiveLow: 2, isLowPerformer: true, warningCount: 2, warningsSent: 2, warningPeriods: ['2026-09', '2026-10'], needsReevaluation: true },
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
                    {(b.warningCount ?? 0) > 0 && (
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        <span style={{
                          padding: '2px 8px', borderRadius: 4, fontWeight: 600,
                          background: b.needsReevaluation ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                          color: b.needsReevaluation ? '#DC2626' : '#D97706',
                        }}>
                          {b.warningCount} warning{(b.warningCount ?? 0) !== 1 ? 's' : ''} ({b.warningsSent ?? 0} sent)
                          {b.needsReevaluation && ' · reevaluate'}
                        </span>
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

type ReceiptBreakdown = Record<string, { count: number; total: number }>

function ReceiptStatusSummary({ breakdown }: { breakdown: ReceiptBreakdown }) {
  const statusMap: { key: string; label: string; color: string }[] = [
    { key: 'auto_pass', label: 'Auto-approved', color: '#0088CE' },
    { key: 'approved', label: 'Manually approved', color: '#059669' },
    { key: 'review', label: 'Pending review', color: '#D97706' },
    { key: 'rejected', label: 'Rejected', color: '#DC2626' },
    { key: 'ocr_failed', label: 'OCR failed', color: '#6B7280' },
    { key: 'pending', label: 'Processing', color: '#9CA3AF' },
  ]
  const statuses = statusMap
    .map(s => ({ ...s, count: breakdown[s.key]?.count ?? 0 }))
    .filter(s => s.count > 0)
  const total = statuses.reduce((a, s) => a + s.count, 0)

  if (total === 0) {
    return <div className="muted" style={{ fontSize: 13, padding: '20px 0' }}>No receipts this period</div>
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--bl-navy)' }}>{total}</span>
        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>receipts</span>
      </div>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 16 }}>
        {statuses.map(s => (
          <div key={s.key} style={{ width: `${Math.max((s.count / total) * 100, 3)}%`, background: s.color }} title={`${s.label}: ${s.count}`} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {statuses.map(s => (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
              <span style={{ color: 'var(--bl-navy)' }}>{s.label}</span>
            </div>
            <div style={{ display: 'flex', gap: 12, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontWeight: 600, color: 'var(--bl-navy)' }}>{s.count}</span>
              <span className="muted" style={{ width: 36, textAlign: 'right' }}>{total > 0 ? Math.round((s.count / total) * 100) : 0}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function BarChartPlaceholder({ data }: { data?: Record<string, number> }) {
  const entries = data ? Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).slice(-12) : []
  if (entries.length === 0) {
    return <div className="muted" style={{ fontSize: 13, padding: '20px 0' }}>No invoice data yet</div>
  }
  const bars = entries.map(([, v]) => v)
  const labels = entries.map(([m]) => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' }))
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--midgray)', marginTop: 4 }}>
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </div>
  )
}

export default function AdminDashboard() {
  const [s, setS] = useState({
    activeBams: 0, receiptsSubmitted: 0, missingReceipts: 0,
    reviewQueue: 0, budgetUsed: '$0 / $0', invoicesSent: 0, pendingOnboarding: 0,
    budgetPct: 0
  })
  const [reimbByMonth, setReimbByMonth] = useState<Record<string, number>>({})
  const [invoicesByMonth, setInvoicesByMonth] = useState<Record<string, number>>({})
  const [receiptBreakdown, setReceiptBreakdown] = useState<ReceiptBreakdown>({})
  const [bamSpending, setBamSpending] = useState<BamSpending[]>([])
  const [spendingView, setSpendingView] = useState<'low' | 'all'>('low')
  const router = useRouter()

  useEffect(() => {
    const period = currentPeriod()
    fetch(`/api/admin/data?table=dashboard&period=${period}`)
      .then(res => res.json())
      .then(({ data }) => {
        if (!data) return
        const { activeBams, pendingBams, receiptsSubmitted, reviewQueue, invoicesSent,
          invoicesByMonth: ibm, reimbByMonth: rbm, receiptBreakdown: rb,
          budgetCap, budgetSpent, budgetPct } = data

        setS({
          activeBams: activeBams ?? 0,
          receiptsSubmitted: receiptsSubmitted ?? 0,
          missingReceipts: activeBams > 0 ? Math.max(0, activeBams - receiptsSubmitted) : 0,
          reviewQueue: reviewQueue ?? 0,
          budgetUsed: `$${(budgetSpent ?? 0).toLocaleString()} / $${(budgetCap ?? 0).toLocaleString()}`,
          invoicesSent: invoicesSent ?? 0,
          pendingOnboarding: pendingBams ?? 0,
          budgetPct: budgetPct ?? 0
        })
        if (rb) setReceiptBreakdown(rb)
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
          <KpiCell label="Active BAMs"       value={String(s.activeBams)}        trend="neutral" onClick={() => router.push('/admin/roster')} />
          <KpiCell label="Receipts submitted" value={`${s.receiptsSubmitted} / ${s.activeBams}`} delta={`${s.missingReceipts} missing`} trend={s.missingReceipts > 0 ? 'down' : 'up'} onClick={() => router.push('/admin/receipts')} />
          <KpiCell label="Review queue"      value={String(s.reviewQueue)}       hint="Action needed" trend="neutral" onClick={() => router.push('/admin/receipts')} />
          <KpiCell label="Budget used"       value={s.budgetUsed}                delta={`${s.budgetPct}%`} trend={s.budgetPct > 0 ? 'up' : 'neutral'} onClick={() => router.push('/admin/cohorts')} />
          <KpiCell label="Invoices sent"     value={String(s.invoicesSent)}      hint="cycle: Sept 16" onClick={() => router.push('/admin/invoices')} />
          <KpiCell label="Pending onboarding" value={String(s.pendingOnboarding)} hint="need bank info" trend={s.pendingOnboarding > 0 ? 'down' : 'up'} onClick={() => router.push('/admin/roster')} />
        </div>
      </div>

      <div className="surface">
        <div className="surface-header">
          <div className="chart-headline">Monthly reimbursement</div>
          <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => window.location.reload()}>Refresh</button>
        </div>

        <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--bl-navy)', letterSpacing: '-0.02em', marginBottom: 4 }}>
          {s.budgetPct}% <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--midgray)' }}>of monthly cap</span>
        </div>

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
          <ReceiptStatusSummary breakdown={receiptBreakdown} />
        </div>
      </div>

      <BamSpendingSection bamSpending={bamSpending} spendingView={spendingView} setSpendingView={setSpendingView} />
    </>
  )
}
