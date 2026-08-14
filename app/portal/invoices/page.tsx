'use client'
import { useEffect, useState } from 'react'
import { browserClient } from '@/lib/supabase-browser'

type InvoiceRow = {
  id: string
  period: string
  status: string
  invoice_number: string | null
  seq: number | null
  created_at: string
}

const DUMMY_INVOICES: InvoiceRow[] = [
  { id: 'demo-1', period: '2026-09-01', status: 'sent', invoice_number: 'INV-AT1', seq: 1, created_at: '2026-09-16T18:00:00Z' },
  { id: 'demo-2', period: '2026-10-01', status: 'draft', invoice_number: 'INV-AT2', seq: 2, created_at: '2026-10-16T18:00:00Z' },
]

export default function MyInvoices() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [emailing, setEmailing] = useState<string | null>(null)
  const [emailMsg, setEmailMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const isDev = process.env.NODE_ENV === 'development'
        const sb = browserClient()
        const { data: userRes } = await sb.auth.getUser()

        let bamId: string | null = null
        if (userRes.user) {
          const { data: bam } = await sb.from('bams').select('id').eq('auth_user_id', userRes.user.id).single()
          bamId = bam?.id ?? null
        } else if (isDev) {
          const { data: firstBam } = await sb.from('bams').select('id').limit(1).single()
          bamId = firstBam?.id ?? null
        }

        if (!bamId) {
          if (isDev) setInvoices(DUMMY_INVOICES)
          setLoading(false)
          return
        }

        const { data } = await sb
          .from('invoices')
          .select('id, period, status, invoice_number, seq, created_at')
          .eq('bam_id', bamId)
          .order('period', { ascending: false })

        if (!cancelled) {
          const rows = data ?? []
          setInvoices(rows.length > 0 ? rows : isDev ? DUMMY_INVOICES : [])
        }
      } catch {
        if (process.env.NODE_ENV === 'development') setInvoices(DUMMY_INVOICES)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  function periodLabel(period: string) {
    try {
      return new Date(period + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    } catch {
      return period
    }
  }

  /**
   * The three actions, shared between the desktop table row and the mobile card below.
   *
   * Measured at 390px (iPhone 14/15/16, the single most common size among North American
   * students -- roughly 87% of US teens carry an iPhone per Piper Sandler's survey, and this
   * has been Apple's mainstream body size for several generations): the table rendered at
   * 572px wide and all three buttons sat past the right edge of the screen, reachable only by
   * scrolling sideways inside the table. Extracted here so the fix (a stacked mobile card,
   * below) calls the exact same handlers instead of a second copy that can drift from this one.
   */
  function invoiceActions(inv: InvoiceRow, wrap: boolean) {
    if (inv.status === 'draft') return null
    return (
      <div style={{ display: 'flex', gap: 4, flexWrap: wrap ? 'wrap' : 'nowrap' }}>
        <a
          href={`/api/portal/invoices/download?id=${inv.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost"
          style={{ padding: '5px 12px', fontSize: 12, textDecoration: 'none', display: 'inline-block' }}
        >
          View PDF
        </a>
        <button
          className="btn-ghost"
          style={{ padding: '5px 12px', fontSize: 12 }}
          disabled={downloading === inv.id}
          onClick={async () => {
            setDownloading(inv.id)
            try {
              const res = await fetch(`/api/portal/invoices/download?id=${inv.id}`)
              if (!res.ok) return
              const blob = await res.blob()
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `${inv.invoice_number ?? 'invoice'}.pdf`
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(url)
            } finally { setDownloading(null) }
          }}
        >
          {downloading === inv.id ? '...' : 'Download'}
        </button>
        <button
          className="btn-ghost"
          style={{ padding: '5px 12px', fontSize: 12 }}
          disabled={emailing === inv.id}
          onClick={() => emailMeCopy(inv)}
        >
          {emailing === inv.id ? '...' : 'Email me'}
        </button>
      </div>
    )
  }

  async function emailMeCopy(inv: InvoiceRow) {
    setEmailing(inv.id)
    setEmailMsg(null)
    try {
      const res = await fetch('/api/portal/invoices/email-copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: inv.id })
      })
      const j = await res.json()
      // A partial success (the mail went out, but the PDF's storage key could not be
      // recorded) arrives as `warning` and used to be dropped, so the student was told
      // it was sent either way.
      setEmailMsg(
        j.ok
          ? (j.warning ? `Sent, but: ${j.warning}` : 'Invoice copy sent to your email')
          : (j.error || j.message || 'Failed to send')
      )
    } catch {
      setEmailMsg('Failed to send')
    } finally {
      setEmailing(null)
      setTimeout(() => setEmailMsg(null), 4000)
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">My invoices</span></div>
      </div>

      <p className="eyebrow">MY PORTAL</p>
      <h1>My invoices</h1>

      {emailMsg && (
        <div className="badge badge-green" style={{ display: 'inline-block', marginTop: 8, marginBottom: 8, padding: '6px 14px', fontSize: 13 }}>
          {emailMsg}
        </div>
      )}

      <div className="surface" style={{ marginTop: 16, overflowX: 'auto' }}>
        {loading ? (
          <p className="subtle">Loading...</p>
        ) : invoices.length === 0 ? (
          <div className="empty-state">
            No invoices yet. Receipts close on the 15th and invoices are generated the day after.
          </div>
        ) : (
          <>
          {/*
            A 480px table inside a 375px phone makes the whole PAGE scroll sideways, which is
            the most common way a mobile layout breaks. The wrapper confines that scroll to the
            table. globals.css sets `table.admin-table { min-width: 600px }`, so every one of
            these needs a wrapper; /portal/account already had its own and this was the one
            that did not.

            THAT CONTAINMENT WAS NOT ENOUGH ON ITS OWN. Measured at 390px (iPhone 14/15/16,
            the size most North American students carry): the page itself stayed put, but the
            table rendered at 572px and the three action buttons -- View PDF, Download, Email
            me -- sat entirely past the right edge, reachable only by scrolling sideways inside
            a narrow cell. That is not a page-breaking bug, but it is not a usable download
            button either. `.invoice-cards` below is the fix: a stacked layout for phones,
            CSS-toggled against this table at the same breakpoint globals.css already uses for
            the sidebar, so there is one place that defines "this is a phone" rather than two.
          */}
          <div className="table-scroll invoice-table-wrap">
          <table className="admin-table" style={{ minWidth: 480 }}>
            <thead>
              <tr>
                <th>Period</th>
                <th>Invoice #</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id}>
                  <td style={{ fontWeight: 600, color: 'var(--bl-navy)' }}>{periodLabel(inv.period)}</td>
                  <td style={{ fontFamily: 'monospace', color: 'var(--bl-blue)' }}>{inv.invoice_number ?? '—'}</td>
                  <td><span className={`badge badge-${statusBadge(inv.status)}`}>{statusText(inv.status)}</span></td>
                  <td>{invoiceActions(inv, false)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          {/* The phone layout. Same data, same handlers (invoiceActions), no second fetch and
              no duplicated download/email logic to drift out of sync with the table above. */}
          <div className="invoice-cards">
            {invoices.map(inv => (
              <div key={inv.id} className="invoice-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontWeight: 600, color: 'var(--bl-navy)', fontSize: 15 }}>{periodLabel(inv.period)}</span>
                  <span className={`badge badge-${statusBadge(inv.status)}`}>{statusText(inv.status)}</span>
                </div>
                <div style={{ fontFamily: 'monospace', color: 'var(--bl-blue)', fontSize: 13, marginTop: 4 }}>
                  {inv.invoice_number ?? '—'}
                </div>
                {invoiceActions(inv, true) && (
                  <div style={{ marginTop: 10 }}>{invoiceActions(inv, true)}</div>
                )}
              </div>
            ))}
          </div>
          </>
        )}
      </div>
    </>
  )
}

function statusBadge(status: string): string {
  switch (status) {
    case 'sent':  return 'blue'
    case 'paid':  return 'green'
    case 'void':  return 'red'
    case 'draft': return 'yellow'
    default:      return 'yellow'
  }
}

function statusText(status: string): string {
  switch (status) {
    case 'sent':  return 'Sent to AP'
    case 'paid':  return 'Paid'
    case 'void':  return 'Voided'
    case 'draft': return 'Being prepared'
    default:      return status
  }
}
