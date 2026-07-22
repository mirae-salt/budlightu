'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { browserClient } from '@/lib/supabase-browser'

const DEFAULT_CAP = 150

type DashboardState = {
  firstName: string
  spentUsd: number
  capUsd: number
  receiptCount: number
  invoiceStatus: string | null
}

const FALLBACK: DashboardState = {
  firstName: '',
  spentUsd: 0,
  capUsd: DEFAULT_CAP,
  receiptCount: 0,
  invoiceStatus: null
}

export default function Dashboard() {
  const [state, setState] = useState<DashboardState>(FALLBACK)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const sb = browserClient()
        const { data: userRes } = await sb.auth.getUser()
        if (!userRes.user) { setLoading(false); return }

        const period = new Date().toISOString().slice(0, 7) + '-01'
        const next: DashboardState = { ...FALLBACK }

        const { data: bam } = await sb.from('bams').select('id, first_name').eq('auth_user_id', userRes.user.id).single()
        if (bam?.first_name) next.firstName = bam.first_name

        if (bam?.id) {
          const [{ data: ledger }, { data: receipts }, { data: invoice }] = await Promise.all([
            sb.from('reimbursement_ledger').select('spent_usd, spendable_cap_usd').eq('bam_id', bam.id).eq('period', period).maybeSingle(),
            sb.from('receipts').select('id').eq('bam_id', bam.id).eq('period', period),
            sb.from('invoices').select('status').eq('bam_id', bam.id).eq('period', period).maybeSingle()
          ])
          if (ledger) {
            next.spentUsd = Number(ledger.spent_usd ?? 0)
            next.capUsd = Number(ledger.spendable_cap_usd ?? DEFAULT_CAP)
          }
          next.receiptCount = receipts?.length ?? 0
          next.invoiceStatus = invoice?.status ?? null
        }

        if (!cancelled) setState(next)
      } catch {
        // safe fallback
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const invoiceLabel = statusLabel(state.invoiceStatus)

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">Dashboard</span></div>
      </div>

      <p className="eyebrow">MY PORTAL</p>
      <h1>Welcome back{state.firstName ? `, ${state.firstName}` : ''}</h1>

      <div className="hero-card" style={{ marginTop: 20 }}>
        <div className="eyebrow">THIS MONTH</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--paper)', lineHeight: 1 }}>
              {loading ? '—' : `$${state.spentUsd.toFixed(0)}`}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>of your ${state.capUsd.toFixed(0)} allowance used</div>
          </div>
          <Link href="/portal/upload" className="btn" style={{ textDecoration: 'none' }}>Upload receipt</Link>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 20 }}>
        <div className="surface">
          <div className="surface-header"><span className="surface-title">Invoice status</span></div>
          {loading ? (
            <p className="subtle">Loading…</p>
          ) : (
            <>
              <span className={`badge badge-${invoiceLabel.badge}`}>{invoiceLabel.text}</span>
              <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>
                {state.invoiceStatus
                  ? 'Your invoice for this month has been generated.'
                  : 'Your invoice generates automatically around the 16th, once receipts are reviewed.'}
              </p>
            </>
          )}
        </div>

        <div className="surface">
          <div className="surface-header"><span className="surface-title">Receipts</span></div>
          <p className="subtle" style={{ margin: 0 }}>
            {loading
              ? 'Loading…'
              : state.receiptCount > 0
                ? `${state.receiptCount} receipt${state.receiptCount > 1 ? 's' : ''} submitted this month.`
                : 'No receipts submitted yet this month.'}
          </p>
        </div>
      </div>
    </>
  )
}

function statusLabel(status: string | null): { text: string; badge: string } {
  switch (status) {
    case 'sent':  return { text: 'Sent to AP', badge: 'blue' }
    case 'paid':  return { text: 'Paid', badge: 'green' }
    case 'void':  return { text: 'Voided', badge: 'red' }
    case 'draft': return { text: 'Being prepared', badge: 'yellow' }
    default:      return { text: 'Not yet generated', badge: 'yellow' }
  }
}
