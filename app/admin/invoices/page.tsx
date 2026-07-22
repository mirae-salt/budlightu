'use client'

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { DRAFT_INVOICES, type InvoiceRow } from '../_lib/dummy'

type Row = InvoiceRow & { id: string; cohort_id: string | null; period: string }

type DbInvoice = {
  id: string
  invoice_number: string
  period: string
  status: 'draft' | 'sent' | 'paid' | 'void'
  cohort_id: string
  payload_json: { total?: number } | null
  bams: { first_name: string; last_name: string } | null
  receipt_status: string | null
  receipt_total: number | null
}

function periodLabel(period: string): string {
  const d = new Date(period)
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function mapReceiptStatus(s: string | null): InvoiceRow['receiptStatus'] {
  if (s === 'auto_pass') return 'pass'
  if (s === 'approved' || s === 'review' || s === 'rejected' || s === 'fail' || s === 'pass' || s === 'none') return s
  if (s === 'ocr_failed') return 'review'
  if (s === 'pending') return 'review'
  return undefined
}

function mapDbInvoice(inv: DbInvoice): Row {
  const total = inv.payload_json?.total
  return {
    id: inv.id,
    number: inv.invoice_number,
    bam: inv.bams ? `${inv.bams.first_name} ${inv.bams.last_name}` : '—',
    period: inv.period,
    amount: total != null ? `$${Number(total).toFixed(2)}` : '—',
    status: inv.status,
    cohort_id: inv.cohort_id,
    receiptStatus: mapReceiptStatus(inv.receipt_status),
    receiptTotal: inv.receipt_total != null ? `$${Number(inv.receipt_total).toFixed(2)}` : undefined
  }
}

export default function InvoiceBatch() {
  const [invoices, setInvoices] = useState<Row[]>([])
  const [useDb, setUseDb] = useState(false)
  const [batchConfirming, setBatchConfirming] = useState(false)
  const [batchMessage, setBatchMessage] = useState<string | null>(null)
  const [previewNumber, setPreviewNumber] = useState<string | null>(null)
  const [voidingNumber, setVoidingNumber] = useState<string | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [rowMessage, setRowMessage] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/admin/data?table=invoices')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setInvoices((data as DbInvoice[]).map(mapDbInvoice))
          setUseDb(true)
        } else {
          setInvoices(DRAFT_INVOICES.map((inv, i) => ({ ...inv, id: `dummy-${i}`, cohort_id: null, period: '2026-09-01' })))
        }
      })
      .catch(() => {
        setInvoices(DRAFT_INVOICES.map((inv, i) => ({ ...inv, id: `dummy-${i}`, cohort_id: null, period: '2026-09-01' })))
      })
  }, [])

  const total = invoices.reduce((sum, inv) => sum + parseFloat(inv.amount.replace(/[$,]/g, '') || '0'), 0)

  async function confirmBatchApprove() {
    setBatchConfirming(false)
    const draftInvoices = invoices.filter(inv => inv.status === 'draft')
    const first = draftInvoices[0]
    if (!useDb || !first?.cohort_id) {
      setBatchMessage(`${invoices.length} invoices approved. AP emails queued (dryrun mode). BAM copies queued.`)
      setTimeout(() => setBatchMessage(null), 6000)
      return
    }
    try {
      const res = await fetch('/api/admin/invoices/batch-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cohort_id: first.cohort_id, period: first.period })
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) {
        setBatchMessage(json.message || 'Batch approve failed')
      } else {
        setBatchMessage(`Batch approve: ${json.processed ?? 0} invoice(s) processed.`)
      }
    } catch {
      setBatchMessage('Network error — batch approve not sent')
    }
    setTimeout(() => setBatchMessage(null), 6000)
  }

  function startVoid(number: string) {
    setVoidingNumber(number)
    setVoidReason('')
    setPreviewNumber(null)
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); setPdfUrl(null) }
  }

  async function confirmVoid(inv: Row) {
    if (!useDb) {
      setInvoices(list => list.map(i => i.number === inv.number ? { ...i, status: 'void' as const } : i))
      setVoidingNumber(null)
      setRowMessage(`${inv.number} voided — AP cancellation email drafted.`)
      setTimeout(() => setRowMessage(null), 5000)
      return
    }
    try {
      const res = await fetch('/api/admin/invoices/void', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: inv.id, reason: voidReason })
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) {
        setRowMessage(json.message || json.error || 'Void failed')
      } else {
        setInvoices(list => list.map(i => i.id === inv.id ? { ...i, status: 'void' as const } : i))
        setRowMessage(`${inv.number} voided — AP cancellation email drafted.`)
      }
    } catch {
      setRowMessage('Network error — void not saved')
    }
    setVoidingNumber(null)
    setTimeout(() => setRowMessage(null), 5000)
  }

  function downloadFile(filename: string, contents: string, mime = 'text/csv;charset=utf-8;') {
    const blob = new Blob([contents], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfLoading, setPdfLoading] = useState(false)

  async function fetchPdf(inv: Row): Promise<Blob | null> {
    const body = useDb && inv.id && !inv.id.startsWith('dummy-')
      ? { invoice_id: inv.id }
      : { row: { number: inv.number, bam: inv.bam, amount: inv.amount, period: inv.period } }

    const res = await fetch('/api/admin/invoices/preview-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) return null
    return res.blob()
  }

  async function previewPdf(inv: Row) {
    if (previewNumber === inv.number) {
      if (pdfUrl) { URL.revokeObjectURL(pdfUrl); setPdfUrl(null) }
      setPreviewNumber(null)
      return
    }
    setPdfLoading(true)
    setPreviewNumber(inv.number)
    setVoidingNumber(null)
    setPdfUrl(null)
    const blob = await fetchPdf(inv)
    if (blob) setPdfUrl(URL.createObjectURL(blob))
    setPdfLoading(false)
  }

  async function downloadOne(inv: Row) {
    const blob = await fetchPdf(inv)
    if (!blob) {
      setRowMessage('PDF generation failed')
      setTimeout(() => setRowMessage(null), 4000)
      return
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${inv.number}.pdf`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function downloadAll() {
    // No JSZip dependency installed yet — fall back to a single CSV export
    // (same pattern as the audit log page) rather than a real .zip.
    const header = ['Invoice #', 'BAM', 'Period', 'Amount', 'Status', 'Flag']
    const rows = invoices.map(inv => [inv.number, inv.bam, periodLabel(inv.period), inv.amount, inv.status, inv.flag ?? ''])
    const csv = [header, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile(`blu-invoices-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8;')
  }

  async function emailToAp(inv: Row) {
    try {
      const res = await fetch('/api/admin/send-ap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: inv.id })
      })
      if (res.status === 404) {
        setRowMessage('AP email endpoint not configured yet.')
      } else if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setRowMessage(`AP email failed: ${body.message ?? res.statusText}`)
      } else {
        const json = await res.json().catch(() => ({}))
        setRowMessage(json.failed ? `${inv.number}: AP send failed.` : `${inv.number} queued for AP email.`)
      }
    } catch {
      setRowMessage('AP email endpoint not configured yet.')
    }
    setTimeout(() => setRowMessage(null), 5000)
  }

  return (
    <>
      <TopBar crumbs={['Invoices', 'Batch approval']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">
            Batch approval
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>{invoices.length} invoices · <strong>${total.toFixed(2)}</strong></span>
            <button className="btn-ghost" onClick={downloadAll} disabled={invoices.length === 0}>
              Download all (CSV)
            </button>
            <button onClick={() => setBatchConfirming(true)} disabled={invoices.length === 0}>
              Approve batch ({invoices.length})
            </button>
          </div>
        </div>

        {batchConfirming && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 10, fontSize: 13 }}>
              Approve {invoices.length} invoices? This will send AP emails.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmBatchApprove}>Confirm approve</button>
              <button className="btn-ghost" onClick={() => setBatchConfirming(false)}>Cancel</button>
            </div>
          </div>
        )}

        {batchMessage && (
          <div className="badge badge-green" style={{ marginBottom: 16, display: 'inline-block' }}>{batchMessage}</div>
        )}
        {rowMessage && (
          <div className="badge badge-green" style={{ marginBottom: 16, marginLeft: 8, display: 'inline-block' }}>{rowMessage}</div>
        )}

        <table className="admin-table">
          <thead>
            <tr>
              <th>Invoice #</th><th>BAM</th><th>Period</th><th>Amount</th><th>Receipt</th><th>Status</th><th>Flag</th><th></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map(inv => (
              <Fragment key={inv.number}>
                <tr>
                  <td style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--bl-navy)' }}>{inv.number}</td>
                  <td style={{ fontWeight: 600 }}>{inv.bam}</td>
                  <td className="muted">{periodLabel(inv.period)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{inv.amount}</td>
                  <td>
                    {inv.receiptStatus === 'pass'
                      ? <span className="badge badge-green" style={{ fontSize: 10 }}>PASS {inv.receiptTotal}</span>
                      : inv.receiptStatus === 'approved'
                      ? <span className="badge badge-green" style={{ fontSize: 10 }}>APPROVED {inv.receiptTotal}</span>
                      : inv.receiptStatus === 'review'
                      ? <span className="badge badge-yellow" style={{ fontSize: 10 }}>REVIEW {inv.receiptTotal}</span>
                      : inv.receiptStatus === 'rejected'
                      ? <span className="badge badge-red" style={{ fontSize: 10 }}>REJECTED</span>
                      : inv.receiptStatus === 'fail'
                      ? <span className="badge badge-red" style={{ fontSize: 10 }}>FAIL {inv.receiptTotal}</span>
                      : <span className="muted" style={{ fontSize: 11 }}>—</span>}
                  </td>
                  <td>
                    {inv.status === 'void'
                      ? <span className="badge badge-red">VOID</span>
                      : inv.status === 'sent'
                      ? <span className="badge badge-green">SENT</span>
                      : inv.status === 'paid'
                      ? <span className="badge badge-blue">PAID</span>
                      : <span className="badge badge-yellow">DRAFT</span>}
                  </td>
                  <td>
                    {inv.flag
                      ? <span className="badge badge-yellow" style={{ background: 'var(--yellow-tint)' }}>{inv.flag}</span>
                      : <span className="muted" style={{ fontSize: 12 }}>—</span>}
                  </td>
                  <td>
                    {inv.status === 'void' ? (
                      <span className="muted" style={{ fontSize: 12 }}>Voided</span>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => previewPdf(inv)}>
                          {previewNumber === inv.number ? 'Close' : 'Preview'}
                        </button>
                        <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => downloadOne(inv)}>
                          PDF
                        </button>
                        <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => emailToAp(inv)}>
                          AP
                        </button>
                        <button
                          className="btn-ghost"
                          style={{ padding: '3px 8px', fontSize: 11, color: 'var(--red)', borderColor: 'var(--red)' }}
                          onClick={() => startVoid(inv.number)}
                        >
                          Void
                        </button>
                      </div>
                    )}
                  </td>
                </tr>

                {previewNumber === inv.number && (
                  <tr>
                    <td colSpan={8} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      {pdfLoading && <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Generating PDF…</div>}
                      {pdfUrl && (
                        <iframe
                          src={pdfUrl}
                          style={{ width: '100%', height: 600, border: '1px solid var(--stone)', borderRadius: 8, background: '#fff' }}
                          title={`PDF preview: ${inv.number}`}
                        />
                      )}
                      {!pdfLoading && !pdfUrl && (
                        <div className="muted" style={{ padding: 20, textAlign: 'center' }}>PDF generation failed. Check server logs.</div>
                      )}
                    </td>
                  </tr>
                )}

                {voidingNumber === inv.number && (
                  <tr>
                    <td colSpan={8} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      <div className="card" style={{ maxWidth: 420 }}>
                        <div className="field">
                          <label>Void reason</label>
                          <input
                            placeholder="e.g. duplicate submission, wrong amount…"
                            value={voidReason}
                            onChange={e => setVoidReason(e.target.value)}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            style={{ background: 'var(--red)' }}
                            disabled={!voidReason.trim()}
                            onClick={() => confirmVoid(inv)}
                          >
                            Confirm void
                          </button>
                          <button className="btn-ghost" onClick={() => setVoidingNumber(null)}>Cancel</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <div className="empty-state">No draft or sent invoices for this cycle.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
