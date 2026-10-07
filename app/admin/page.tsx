'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TopBar } from './_components/TopBar'
import { KpiCell } from './_components/StatCard'
import { presetCohortFilter } from './_components/CohortFilter'
import { LineChartPlaceholder } from './_components/LineChartPlaceholder'
import { RECEIPT_DEADLINE_DAY, INVOICE_GENERATE_DAY } from '@/lib/cycle-schedule'
// No dummy imports - all data from DB

type BamSpending = {
  bam_id: string; cohort_id?: string; name: string; email: string; cohort: string
  monthly: Record<string, number>; totalSpent: number; avgMonthly: number
  lowMonths: number; consecutiveLow: number; isLowPerformer: boolean
  warningCount?: number; warningsSent?: number; warningPeriods?: string[]
  needsReevaluation?: boolean
}

/**
 * P1-14: there used to be a FAKE_BAM_SPENDING fixture here, and the dashboard
 * fell back to it whenever real data had fewer than two months per BAM, which is
 * the program's current state. It rendered with no marker, so Robin would have
 * made budget decisions on invented numbers. Fixtures are gone. When there is no
 * data the dashboard says there is no data.
 */
type LoadState = 'loading' | 'ok' | 'empty' | 'error'

function currentPeriod(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

/** The first month with data. The stepper stops here instead of walking into empty years. */
const FIRST_PERIOD = '2026-08-01'

function periodLabel(period: string): string {
  return new Date(`${period}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function shiftPeriod(period: string, offset: number): string {
  const [y, m] = period.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 10)
}

function PeriodBanner({ period }: { period: string }) {
  const isCurrent = period === currentPeriod()
  const day = new Date().getDate()
  return (
    <p className="overview-period">
      <strong>{periodLabel(period)}</strong>
      {isCurrent
        ? <span>Receipts {day > RECEIPT_DEADLINE_DAY ? 'closed' : `due ${RECEIPT_DEADLINE_DAY}th`}</span>
        : <span>Receipts closed</span>}
      <span>Draft invoices {INVOICE_GENERATE_DAY}th</span>
    </p>
  )
}

/** Same arrows as the invoices screen. The next arrow stops at the current month: nothing exists after it. */
function MonthStepper({ period, onChange }: { period: string; onChange: (p: string) => void }) {
  const current = currentPeriod()
  return (
    <div className="invoice-month-group" role="group" aria-label="Dashboard month" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
      <button className="invoice-month-arrow" aria-label="Previous month" title="Previous month"
        disabled={period <= FIRST_PERIOD} onClick={() => onChange(shiftPeriod(period, -1))}>‹</button>
      <span className="invoice-month-current" aria-live="polite">{periodLabel(period)}</span>
      <button className="invoice-month-arrow" aria-label="Next month" title="Next month"
        disabled={period >= current} onClick={() => onChange(shiftPeriod(period, 1))}>›</button>
      {period !== current && (
        <button className="invoice-month-quick" onClick={() => onChange(current)}>This month</button>
      )}
    </div>
  )
}

/**
 * Visible failure. A dashboard that quietly renders zeros after a failed fetch
 * is worse than one that says it is broken.
 */
function LoadErrorBanner({ what, detail, onRetry }: {
  what: string; detail: string | null; onRetry: () => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap',
      padding: '12px 16px', borderRadius: 10, marginBottom: 16,
      background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)'
    }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#B91C1C' }}>
          Could not load the {what}
        </div>
        <div style={{ fontSize: 12, color: '#7F1D1D', marginTop: 2 }}>
          Nothing on screen for this section is trustworthy. {detail ? `Details: ${detail}` : ''}
        </div>
      </div>
      <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 12 }} onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

function BamSpendingSection({ bamSpending, spendingView, setSpendingView, state, error }: {
  bamSpending: BamSpending[]; spendingView: 'low' | 'all'; setSpendingView: (v: 'low' | 'all') => void
  state: LoadState; error: string | null
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

  // P1-14: no fixture fallback. Show the real state of the data instead.
  if (state !== 'ok') {
    return (
      <div className="surface">
        <div className="surface-header">
          <span className="surface-title">BAM spending across all months</span>
        </div>
        {state === 'error'
          ? <LoadErrorBanner what="BAM spending data" detail={error} onRetry={() => window.location.reload()} />
          : <div className="empty-state" style={{ padding: 40 }}>
              {state === 'loading'
                ? 'Loading BAM spending...'
                : 'No spending data yet. This table fills in once approved receipts exist for active BAMs.'}
            </div>}
      </div>
    )
  }

  return (
    <div className="surface">
      <div className="surface-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="surface-title">BAM spending across all months</span>
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
          <div style={{ fontSize: 12, color: 'var(--midgray)', marginBottom: 4 }}>Budget, all recorded months</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--bl-navy)', fontVariantNumeric: 'tabular-nums' }}>
            ${totals.cap.toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: 'var(--midgray)' }}>${CAP_PER_MONTH}/mo × {enriched.length} BAMs</div>
        </div>
        <div style={{ background: 'var(--stone-lt, #f5f5f0)', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ fontSize: 12, color: 'var(--midgray)', marginBottom: 4 }}>Spent, all recorded months</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--bl-blue, #0088CE)', fontVariantNumeric: 'tabular-nums' }}>
            ${Math.round(totals.spent).toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: 'var(--midgray)' }}>{totals.cap > 0 ? Math.round((totals.spent / totals.cap) * 100) : 0}% of budget</div>
        </div>
        <div style={{ background: 'var(--stone-lt, #f5f5f0)', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ fontSize: 12, color: 'var(--midgray)', marginBottom: 4 }}>Remaining, all recorded months</div>
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
              background: i === bars.length - 1 ? 'var(--bl-blue)' : 'rgba(0,180,224,0.18)',
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
    activeBams: 0, receiptsSubmitted: 0,
    reviewQueue: 0, budgetUsed: '$0 / $0', invoicesSent: 0, pendingOnboarding: 0,
    budgetPct: 0
  })
  const [reimbByMonth, setReimbByMonth] = useState<Record<string, number>>({})
  const [invoicesByMonth, setInvoicesByMonth] = useState<Record<string, number>>({})
  const [receiptBreakdown, setReceiptBreakdown] = useState<ReceiptBreakdown>({})
  const [bamSpending, setBamSpending] = useState<BamSpending[]>([])
  const [spendingView, setSpendingView] = useState<'low' | 'all'>('low')
  const [statsState, setStatsState] = useState<LoadState>('loading')
  const [statsError, setStatsError] = useState<string | null>(null)
  const [spendingState, setSpendingState] = useState<LoadState>('loading')
  const [spendingError, setSpendingError] = useState<string | null>(null)
  const [reviewCohortId, setReviewCohortId] = useState<string | null>(null)
  const [budgetSource, setBudgetSource] = useState<'ledger' | 'receipts_capped' | null>(null)
  const [dataWarnings, setDataWarnings] = useState<string[]>([])
  const router = useRouter()
  const [period, setPeriod] = useState<string>(currentPeriod())
  const isCurrentMonth = period === currentPeriod()

  useEffect(() => {
    setStatsState('loading')
    let cancelled = false

    // P1-14: load errors are surfaced, not swallowed. A dashboard that shows
    // zeros because a fetch failed is indistinguishable from a real zero.
    fetch(`/api/admin/data?table=dashboard&period=${period}`)
      .then(async res => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json.error || !json.data) {
          throw new Error(json.error || json.message || `Request failed (${res.status})`)
        }
        return json.data
      })
      .then(data => {
        if (cancelled) return
        const { activeBams, pendingBams, receiptsSubmitted, reviewQueue, reviewCohortId: rqCohort, invoicesSent,
          invoicesByMonth: ibm, reimbByMonth: rbm, receiptBreakdown: rb,
          budgetCap, budgetSpent, budgetPct, budgetSource: src } = data

        setS({
          activeBams: activeBams ?? 0,
          receiptsSubmitted: receiptsSubmitted ?? 0,
          reviewQueue: reviewQueue ?? 0,
          budgetUsed: `$${(budgetSpent ?? 0).toLocaleString()} / $${(budgetCap ?? 0).toLocaleString()}`,
          invoicesSent: invoicesSent ?? 0,
          pendingOnboarding: pendingBams ?? 0,
          budgetPct: budgetPct ?? 0
        })
        setReviewCohortId(rqCohort ?? null)
        if (rb) setReceiptBreakdown(rb)
        if (ibm) setInvoicesByMonth(ibm)
        if (rbm) setReimbByMonth(rbm)
        if (src === 'ledger' || src === 'receipts_capped') setBudgetSource(src)
        if (Array.isArray(data.warnings) && data.warnings.length > 0) {
          setDataWarnings(prev => [...new Set([...prev, ...(data.warnings as string[])])])
        }
        setStatsState('ok')
      })
      .catch((e: Error) => {
        if (cancelled) return
        setStatsError(e.message)
        setStatsState('error')
      })

    return () => { cancelled = true }
  }, [period])

  // Not month-based: it is the whole program, so it loads once.
  useEffect(() => {

    fetch('/api/admin/data?table=bam_spending')
      .then(async res => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json.error || !json.data) {
          throw new Error(json.error || json.message || `Request failed (${res.status})`)
        }
        return json as { data: BamSpending[]; warnings?: string[] }
      })
      .then(json => {
        setBamSpending(json.data)
        if (json.warnings && json.warnings.length > 0) {
          setDataWarnings(prev => [...prev, ...json.warnings!])
        }
        setSpendingState(json.data.length > 0 ? 'ok' : 'empty')
      })
      .catch((e: Error) => {
        setBamSpending([])
        setSpendingError(e.message)
        setSpendingState('error')
      })
  }, [])
  return (
    <>
      <TopBar crumbs={['Dashboard', 'Overview']} />

      <div className="admin-overview">
      {statsState === 'error' && (
        <LoadErrorBanner
          what="program summary"
          detail={statsError}
          onRetry={() => window.location.reload()}
        />
      )}

      {dataWarnings.length > 0 && (
        <div style={{
          padding: '12px 16px', borderRadius: 10, marginBottom: 16,
          background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.25)'
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#92400E' }}>
            Some figures on this page are incomplete
          </div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: '#78350F' }}>
            {dataWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* The queue and the onboarding list are live, not per month, so they belong to this month's view only. */}
      {statsState === 'ok' && isCurrentMonth && (
        <section className="overview-worklist" aria-label="Needs attention">
          <div className="overview-worklist-heading">
            <strong>Needs attention</strong>
          </div>
          <div className="overview-worklist-links">
            {s.reviewQueue > 0 && <button type="button" onClick={() => { if (reviewCohortId) presetCohortFilter(reviewCohortId); router.push('/admin/receipts') }}>
              Review receipts <strong>{s.reviewQueue}</strong>
            </button>}
            {s.pendingOnboarding > 0 && <button type="button" onClick={() => router.push('/admin/roster')}>
              Pending onboarding <strong>{s.pendingOnboarding}</strong>
            </button>}
            {s.reviewQueue === 0 && s.pendingOnboarding === 0 && <span className="muted">Nothing waiting right now</span>}
            <button type="button" className="overview-worklist-secondary" onClick={() => router.push('/admin/invoices')}>
              Open invoice batch <span aria-hidden="true">↗</span>
            </button>
          </div>
        </section>
      )}

      <MonthStepper period={period} onChange={setPeriod} />
      <PeriodBanner period={period} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">{isCurrentMonth ? 'This month at a glance' : `${periodLabel(period)} at a glance`}</div>
        </div>
        {statsState === 'loading' && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Loading current figures...</div>
        )}
        {statsState === 'error' && (
          <div style={{ fontSize: 12, color: '#B91C1C', marginBottom: 8, fontWeight: 600 }}>
            Figures below could not be loaded. Do not use them.
          </div>
        )}
        <div className="kpi-row" style={statsState === 'error' ? { opacity: 0.35 } : undefined}>
          <KpiCell label="Active BAMs"       value={String(s.activeBams)}        trend="neutral" onClick={() => router.push('/admin/roster')} />
          <KpiCell label="Receipts uploaded" value={String(s.receiptsSubmitted)} hint={isCurrentMonth ? 'This cycle' : periodLabel(period)} onClick={() => router.push('/admin/receipts')} />
          <KpiCell label={isCurrentMonth ? 'Budget used this month' : 'Budget used'} value={s.budgetUsed}           delta={`${s.budgetPct}%`} trend={s.budgetPct > 0 ? 'up' : 'neutral'} onClick={() => router.push('/admin/cohorts')} />
          <KpiCell label="Invoices sent"     value={String(s.invoicesSent)}      hint={isCurrentMonth ? 'This cycle' : periodLabel(period)} onClick={() => router.push('/admin/invoices')} />
        </div>
      </div>

      <div className="grid-2">
        <div className="surface" style={{ marginBottom: 0 }}>
          <div className="surface-header">
            <div className="surface-title">Invoice volume</div>
            <span className="muted" style={{ fontSize: 12 }}>All recorded months</span>
          </div>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--bl-navy)' }}>
              {Object.values(invoicesByMonth).reduce((a, v) => a + v, 0)}
            </span>
            <span className="badge badge-blue" style={{ marginLeft: 8 }}>
              {Object.keys(invoicesByMonth).length === 0 ? 'no invoices yet' : 'draft plus sent'}
            </span>
          </div>
          {Object.keys(invoicesByMonth).length > 0
            ? <BarChartPlaceholder data={invoicesByMonth} />
            : <div className="empty-state" style={{ padding: 24, fontSize: 13 }}>
                No invoices have been generated yet.
              </div>}
        </div>

        <div className="surface" style={{ marginBottom: 0 }}>
          <div className="surface-header">
            <div className="surface-title">Receipt status</div>
            <span className="muted" style={{ fontSize: 12 }}>{isCurrentMonth ? 'this month' : periodLabel(period)}</span>
          </div>
          <ReceiptStatusSummary breakdown={receiptBreakdown} />
        </div>
      </div>

      <div className="surface">
        <div className="surface-header">
          <div className="chart-headline">Monthly reimbursement</div>
          <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => window.location.reload()}>Refresh</button>
        </div>
        {statsState === 'ok' && budgetSource === 'receipts_capped' && (
          <div style={{ fontSize: 11, color: 'var(--midgray)', marginBottom: 8 }}>
            Estimate from approved receipts. The reimbursement ledger has no entries for {isCurrentMonth ? 'this month' : periodLabel(period)} yet.
          </div>
        )}
        {statsState === 'ok' && budgetSource === 'ledger' && (
          <div style={{ fontSize: 11, color: 'var(--midgray)', marginBottom: 8 }}>
            Payable amounts from the reimbursement ledger.
          </div>
        )}
        {Object.keys(reimbByMonth).length > 0
          ? <LineChartPlaceholder data={reimbByMonth} />
          : <div className="empty-state" style={{ padding: 32, fontSize: 13 }}>
              No reimbursement history yet.
            </div>}
      </div>

      <BamSpendingSection
        bamSpending={bamSpending}
        spendingView={spendingView}
        setSpendingView={setSpendingView}
        state={spendingState}
        error={spendingError}
      />
      </div>
    </>
  )
}
