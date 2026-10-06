'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { browserClient } from '@/lib/supabase-browser'
import { AttestationPrompt } from '../_components/AttestationPrompt'
import { INVOICE_GENERATE_DAY } from '@/lib/cycle-schedule'

const DEFAULT_CAP = 150

type DashboardState = {
  firstName: string
  spentCad: number
  capCad: number
  receiptCount: number
  invoiceStatus: string | null
}

const FALLBACK: DashboardState = {
  firstName: '',
  spentCad: 0,
  capCad: DEFAULT_CAP,
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

        const { data: bam } = await sb.from('bams').select('id, first_name, status, bank_name, street, email_verified_at').eq('auth_user_id', userRes.user.id).single()
        if (bam && (!bam.bank_name || !bam.street || bam.status === 'pending')) {
          window.location.href = '/portal/onboarding'
          return
        }
        // P0-4: first-login banking confirmation gate. Must happen before
        // anything else (incl. unlocking BAM-copy sends of banking info).
        if (bam && !bam.email_verified_at) {
          window.location.href = '/portal/verify-account'
          return
        }
        if (bam?.first_name) next.firstName = bam.first_name

        if (bam?.id) {
          const [{ data: ledger }, { data: receipts }, { data: invoice }] = await Promise.all([
            sb.from('reimbursement_ledger').select('spent_cad, spendable_cap_cad').eq('bam_id', bam.id).eq('period', period).maybeSingle(),
            sb.from('receipts').select('id').eq('bam_id', bam.id).eq('period', period),
            sb.from('invoices').select('status').eq('bam_id', bam.id).eq('period', period).maybeSingle()
          ])
          if (ledger) {
            next.spentCad = Number(ledger.spent_cad ?? 0)
            next.capCad = Number(ledger.spendable_cap_cad ?? DEFAULT_CAP)
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
      {/* Shows only for people who onboarded before these questions existed. It sits
          after the redirect gates above, so nobody sees it before verifying. */}
      <AttestationPrompt />

      <div className="topbar">
        <div className="crumbs"><span className="now">Dashboard</span></div>
      </div>

      <h1>Welcome back{state.firstName ? `, ${state.firstName}` : ''}</h1>

      <div className="surface dashboard-summary" style={{ marginTop: 20 }}>
        <div>
          <div className="dashboard-summary-label">Bud Light spend this month</div>
            {/*
              Cents, not a rounded dollar. This was toFixed(0), so $58.45 of spend read
              as "$58" here and $58.45 on the invoice, and 45 cents looked like it had
              gone missing. Money a student can check against a document should be
              printed the way the document prints it.
            */}
            <div className="dashboard-summary-value">
              {loading ? '—' : `$${state.spentCad.toFixed(2)}`}
            </div>
        </div>
        <Link href="/portal/upload" className="btn" style={{ textDecoration: 'none' }}>Upload receipt</Link>
      </div>

      <div className="surface dashboard-status" style={{ marginTop: 16 }}>
        <div className="dashboard-status-item">
          <div className="surface-header"><span className="surface-title">Invoice status</span></div>
          {loading ? (
            <p className="subtle">Loading…</p>
          ) : (
            <>
              <div className="dashboard-status-value">{invoiceLabel.text}</div>
              <p className="dashboard-status-note">
                {state.invoiceStatus
                  ? 'See My invoices for details'
                  : `Drafts prepared from the ${INVOICE_GENERATE_DAY}th`}
              </p>
            </>
          )}
        </div>

        <div className="dashboard-status-item">
          <div className="surface-header"><span className="surface-title">Receipts</span></div>
          <div className="dashboard-status-value">{loading ? '—' : `${state.receiptCount} submitted`}</div>
          <p className="dashboard-status-note">This month</p>
        </div>
      </div>

      <MonthlyTags />
    </>
  )
}

function statusLabel(status: string | null): { text: string; badge: string } {
  switch (status) {
    case 'sent':  return { text: 'Sent to AP', badge: 'blue' }
    case 'paid':  return { text: 'Paid', badge: 'green' }
    case 'void':  return { text: 'Voided', badge: 'red' }
    case 'draft': return { text: 'Being prepared', badge: 'yellow' }
    default:      return { text: 'Not yet prepared', badge: 'yellow' }
  }
}

const ALWAYS_TAGS = ['#BudLightPartner', '#BudLightU', '@budlightca']
const NFL_MONTHS = [9, 10, 11, 0, 1] // Oct–Feb (0-indexed)

type MonthConfig = {
  month: string
  tags: string[]
  extras: string[]
  tip: string
}

function getMonthConfig(): MonthConfig {
  const now = new Date()
  const m = now.getMonth()
  const monthName = now.toLocaleString('en-US', { month: 'long' })
  const isNfl = NFL_MONTHS.includes(m)

  const extras: string[] = []
  if (isNfl) extras.push('@NFLCanada')

  const tips: Record<number, string> = {
    8:  'Welcome month! Kick things off with a back-to-school post featuring BL.',
    9:  'NFL season starts! Include @NFLCanada on game-day content.',
    10: 'Halloween content opportunity. Team can Reels eligible ($50 bonus).',
    11: 'Grey Cup month! Big NFL push. Tag @NFLCanada on all game content.',
    0:  'New year content. NFL playoffs, keep tagging @NFLCanada.',
    1:  'Super Bowl month! Last NFL push of the season.',
    2:  'March Madness vibes. Spring content planning starts.',
    3:  'Wrap-up month. Final invoices and content submissions.',
  }

  return {
    month: monthName,
    tags: ALWAYS_TAGS,
    extras,
    tip: tips[m] ?? 'Post your monthly content and tag correctly!',
  }
}

function MonthlyTags() {
  const config = getMonthConfig()
  const allTags = [...config.tags, ...config.extras]
  const [copied, setCopied] = useState(false)

  function copyAll() {
    navigator.clipboard.writeText(allTags.join(' ')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="surface" style={{ marginTop: 20 }}>
      <div className="surface-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="surface-title">Tags for {config.month}</span>
        <button
          onClick={copyAll}
          className="btn-ghost"
          style={{ fontSize: 12, padding: '4px 12px' }}
        >
          {copied ? 'Copied!' : 'Copy all'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {config.tags.map(tag => (
          <span key={tag} style={{
            padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
            background: 'var(--bl-blue)', color: 'var(--bl-navy)'
          }}>{tag}</span>
        ))}
        {config.extras.map(tag => (
          <span key={tag} style={{
            padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
            background: 'var(--bl-navy)', color: '#fff'
          }}>{tag}</span>
        ))}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {config.tip}
      </p>
      {config.extras.length > 0 && (
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
          <strong style={{ color: 'var(--bl-navy)' }}>NFL season</strong>: dark tags are active this month only.
        </p>
      )}
    </div>
  )
}
