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
            No invoices yet. Invoices are generated on the 15th of each month after receipt review.
          </div>
        ) : (
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
                  <td style={{ display: 'flex', gap: 4 }}>
                    {inv.status !== 'draft' && (
                      <>
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
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
