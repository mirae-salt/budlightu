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

export default function MyInvoices() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [printing, setPrinting] = useState<InvoiceRow | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const sb = browserClient()
        const { data: userRes } = await sb.auth.getUser()
        if (!userRes.user) { setLoading(false); return }

        const { data: bam } = await sb.from('bams').select('id').eq('auth_user_id', userRes.user.id).single()
        if (!bam?.id) { setLoading(false); return }

        const { data } = await sb
          .from('invoices')
          .select('id, period, status, invoice_number, seq, created_at')
          .eq('bam_id', bam.id)
          .order('period', { ascending: false })

        if (!cancelled) setInvoices(data ?? [])
      } catch {
        // safe fallback
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

  function printInvoice(inv: InvoiceRow) {
    setPrinting(inv)
    setTimeout(() => window.print(), 50)
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">My invoices</span></div>
      </div>

      <p className="eyebrow">MY PORTAL</p>
      <h1>My invoices</h1>
      <p className="subtle">
        Your monthly invoice generates automatically once your receipts are reviewed.
        A copy is also emailed to you — use this page any time you need another look.
      </p>

      <div className="surface" style={{ marginTop: 20 }}>
        {loading ? (
          <p className="subtle">Loading…</p>
        ) : invoices.length === 0 ? (
          <div className="empty-state">
            No invoices yet — your first invoice will appear here after your receipts are reviewed.
          </div>
        ) : (
          <table className="admin-table">
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
                  <td><button className="btn-ghost" style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => printInvoice(inv)}>View / print</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {printing && (
        <div className="print-only" style={{ marginTop: 32 }}>
          <div className="card" style={{ maxWidth: 480 }}>
            <div style={{ fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 8 }}>
              {printing.invoice_number ?? 'Invoice'}
            </div>
            <div>Period: {periodLabel(printing.period)}</div>
            <div>Status: {statusText(printing.status)}</div>
            <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
              This is a summary view. A PDF download will be available soon.
            </p>
          </div>
        </div>
      )}
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
