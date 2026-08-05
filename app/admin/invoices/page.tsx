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
  if (s === 'auto_pass' || s === 'approved' || s === 'review' || s === 'rejected' || s === 'none') return s
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
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/admin/data?table=invoices')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setInvoices((data as DbInvoice[]).map(mapDbInvoice))
          setUseDb(true)
        }
      })
      .catch(() => {})
  }, [])

  const draftInvoices = invoices.filter(inv => inv.status === 'draft')
  const total = invoices.reduce((sum, inv) => sum + parseFloat(inv.amount.replace(/[$,]/g, '') || '0'), 0)
  const selectedDrafts = draftInvoices.filter(inv => selected.has(inv.id))
  const allDraftsSelected = draftInvoices.length > 0 && draftInvoices.every(inv => selected.has(inv.id))

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (allDraftsSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(draftInvoices.map(inv => inv.id)))
    }
  }

  async function confirmBatchApprove() {
    setBatchConfirming(false)
    if (!useDb || selectedDrafts.length === 0) {
      setBatchMessage(`${selectedDrafts.length} invoices approved. AP emails queued (dryrun mode). BAM copies queued.`)
      setTimeout(() => setBatchMessage(null), 6000)
      return
    }
    try {
      const res = await fetch('/api/admin/invoices/batch-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_ids: selectedDrafts.map(inv => inv.id) })
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) {
        setBatchMessage(json.message || 'Batch approve failed')
      } else {
        setBatchMessage(`Batch approve: ${json.processed ?? 0} invoice(s) processed.`)
        setSelected(new Set())
      }
    } catch {
      setBatchMessage('Network error: batch approve not sent')
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
      setRowMessage(`${inv.number} voided. AP cancellation email drafted.`)
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
        setRowMessage(`${inv.number} voided. AP cancellation email drafted.`)
      }
    } catch {
      setRowMessage('Network error: void not saved')
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
  const [apPreview, setApPreview] = useState<{ inv: Row; sending: boolean } | null>(null)

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

  function downloadCsv() {
    const header = ['Invoice #', 'BAM', 'Period', 'Amount', 'Status', 'Flag']
    const rows = invoices.map(inv => [inv.number, inv.bam, periodLabel(inv.period), inv.amount, inv.status, inv.flag ?? ''])
    const csv = [header, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile(`blu-invoices-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8;')
  }

  const [zipLoading, setZipLoading] = useState(false)

  async function downloadZip() {
    setZipLoading(true)
    try {
      const ids = invoices.filter(i => i.id && !i.id.startsWith('dummy-')).map(i => i.id)
      const res = await fetch('/api/admin/invoices/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_ids: ids.length > 0 ? ids : undefined })
      })
      if (!res.ok) {
        setRowMessage('ZIP download failed')
        setTimeout(() => setRowMessage(null), 4000)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `BLU-Invoices-${new Date().toISOString().slice(0, 10)}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setRowMessage('ZIP download failed. Check server logs')
      setTimeout(() => setRowMessage(null), 4000)
    }
    setZipLoading(false)
  }

  function openApPreview(inv: Row) {
    setApPreview({ inv, sending: false })
  }

  async function confirmSendAp(testEmail?: string) {
    if (!apPreview) return
    const inv = apPreview.inv
    setApPreview({ inv, sending: true })
    try {
      const payload: Record<string, string> = { invoice_id: inv.id }
      if (testEmail) payload.test_email = testEmail
      const res = await fetch('/api/admin/send-ap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      if (res.status === 404) {
        setRowMessage('AP email endpoint not configured yet.')
      } else if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setRowMessage(`AP email failed: ${body.message ?? res.statusText}`)
      } else {
        const json = await res.json().catch(() => ({}))
        if (testEmail) {
          setRowMessage(json.failed ? `Test send failed.` : `Test email sent to ${testEmail}`)
        } else {
          setRowMessage(json.failed ? `${inv.number}: AP send failed.` : `${inv.number} sent to AP.`)
          setInvoices(list => list.map(i => i.id === inv.id ? { ...i, status: 'sent' as const } : i))
        }
      }
    } catch {
      setRowMessage('AP email endpoint not configured yet.')
    }
    setApPreview(null)
    setTimeout(() => setRowMessage(null), 5000)
  }

  const now = new Date()
  const currentMonth = now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
  const day = now.getDate()
  const deadlineDay = 15
  const generateDay = 16
  const daysLeft = deadlineDay - day

  return (
    <>
      <TopBar crumbs={['Invoices', 'Batch approval']} />

      <div className="surface">
        {/* Cycle cadence banner */}
        <div style={{
          padding: '12px 16px', marginBottom: 16, borderRadius: 8,
          background: day < deadlineDay ? 'rgba(0,163,224,0.08)' : day === deadlineDay ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.08)',
          border: `1px solid ${day < deadlineDay ? 'rgba(0,163,224,0.2)' : day === deadlineDay ? 'rgba(245,158,11,0.25)' : 'rgba(34,197,94,0.2)'}`,
          display: 'flex', alignItems: 'center', gap: 12, fontSize: 13,
        }}>
          <span style={{ fontSize: 18 }}>{day < deadlineDay ? '📋' : day <= generateDay ? '⏳' : '✅'}</span>
          <div>
            {day < deadlineDay ? (
              <>
                <strong>{currentMonth} cycle</strong> — Receipt deadline: <strong>{deadlineDay}th</strong> ({daysLeft} day{daysLeft !== 1 ? 's' : ''} left).
                Invoices will be generated on the <strong>{generateDay}th</strong> after all receipts are reviewed.
              </>
            ) : day <= generateDay ? (
              <>
                <strong>{currentMonth} cycle</strong> — Receipt deadline passed. Ready to generate invoices.
                Each BAM gets <strong>1 invoice</strong> (salary + approved receipts capped at $150).
              </>
            ) : (
              <>
                <strong>{currentMonth} cycle</strong> — Invoice generation window open.
                Each BAM × 1 month = <strong>1 invoice</strong> combining salary ($218.75) + reimbursement (up to $150).
              </>
            )}
          </div>
        </div>

        <div className="surface-header">
          <div className="surface-title">
            Batch approval
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>{invoices.length} invoices · <strong>${total.toFixed(2)}</strong></span>
            <button className="btn-ghost" onClick={downloadCsv} disabled={invoices.length === 0}>
              CSV
            </button>
            <button className="btn-ghost" onClick={downloadZip} disabled={invoices.length === 0 || zipLoading}>
              {zipLoading ? 'Zipping…' : 'Download ZIP'}
            </button>
            <button onClick={() => setBatchConfirming(true)} disabled={selectedDrafts.length === 0}>
              Approve selected ({selectedDrafts.length})
            </button>
          </div>
        </div>

        {batchConfirming && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 10, fontSize: 13 }}>
              Approve <strong>{selectedDrafts.length}</strong> of {draftInvoices.length} draft invoices? This will queue AP emails for selected invoices only.
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
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={allDraftsSelected}
                  onChange={toggleAll}
                  title="Select all drafts"
                  style={{ cursor: 'pointer' }}
                />
              </th>
              <th>Invoice #</th><th>BAM</th><th>Period</th><th>Amount</th><th>Receipt</th><th>Status</th><th>Flag</th><th></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map(inv => (
              <Fragment key={inv.number}>
                <tr>
                  <td>
                    {inv.status === 'draft' ? (
                      <input
                        type="checkbox"
                        checked={selected.has(inv.id)}
                        onChange={() => toggleSelect(inv.id)}
                        style={{ cursor: 'pointer' }}
                      />
                    ) : <span />}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--bl-navy)' }}>{inv.number}</td>
                  <td style={{ fontWeight: 600 }}>{inv.bam}</td>
                  <td className="muted">{periodLabel(inv.period)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{inv.amount}</td>
                  <td>
                    {inv.receiptStatus === 'auto_pass'
                      ? <span className="badge badge-green" style={{ fontSize: 10 }}>AUTO-PASS {inv.receiptTotal}</span>
                      : inv.receiptStatus === 'approved'
                      ? <span className="badge badge-green" style={{ fontSize: 10 }}>APPROVED {inv.receiptTotal}</span>
                      : inv.receiptStatus === 'review'
                      ? <span className="badge badge-yellow" style={{ fontSize: 10 }}>REVIEW {inv.receiptTotal}</span>
                      : inv.receiptStatus === 'rejected'
                      ? <span className="badge badge-red" style={{ fontSize: 10 }}>REJECTED {inv.receiptTotal}</span>
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
                        <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => openApPreview(inv)}>
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
                    <td colSpan={9} style={{ background: 'var(--bl-silver)', padding: 16 }}>
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
                    <td colSpan={9} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      <div className="card" style={{ maxWidth: 420 }}>
                        <p style={{ fontSize: 13, marginBottom: 8 }}>
                          Voiding <strong>{inv.number}</strong> ({inv.bam}) will generate an AP cancellation email draft.
                        </p>
                        <div className="field">
                          <label>Why are you voiding this invoice?</label>
                          <input
                            placeholder="e.g. duplicate submission, wrong amount, BAM left program…"
                            value={voidReason}
                            onChange={e => setVoidReason(e.target.value)}
                            autoFocus
                          />
                          {voidReason.trim().length > 0 && voidReason.trim().length < 5 && (
                            <span className="muted" style={{ fontSize: 11, color: 'var(--amber)' }}>
                              A bit more detail please (at least 5 characters)
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            style={{ background: 'var(--red)' }}
                            disabled={voidReason.trim().length < 5}
                            onClick={() => confirmVoid(inv)}
                          >
                            Void invoice
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
                <td colSpan={9}>
                  <div className="empty-state" style={{ padding: '32px 16px', textAlign: 'center' }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--bl-navy)', marginBottom: 8 }}>No invoices yet for this cycle</div>
                    <div style={{ fontSize: 13, color: 'var(--midgray)', lineHeight: 1.6, maxWidth: 440, margin: '0 auto' }}>
                      Invoices are generated on the <strong>16th</strong> after the receipt deadline (15th).
                      Each BAM gets <strong>1 invoice per month</strong> — all approved receipts are automatically
                      summed and capped at $150 for reimbursement, plus salary.
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {apPreview && (() => {
        const inv = apPreview.inv
        const period = new Date(inv.period)
        const month = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
        const apTo = 'accounts.payable@ilovesalt.com'
        const apCc = 'robin.graham@ilovesalt.com, nb@ilovesalt.com'
        const subject = `${inv.bam} ${month} Invoice #${inv.number}`
        const body = `Hi there,\n\nAttached is a ${month} invoice for our Bud Light BAM.\nPlease maintain net15 payment terms with direct deposit.\n\nThis is from BUD LIGHT U - PO# (see cohort config).\n\nThanks,\nProgram Team`
        return (
          <div
            onClick={() => setApPreview(null)}
            style={{
              position: 'fixed', inset: 0, zIndex: 9999,
              background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center',
              padding: 24,
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: 'var(--surface, #fff)', borderRadius: 12,
                boxShadow: '0 8px 40px rgba(0,0,0,0.3)',
                maxWidth: 560, width: '100%', overflow: 'hidden',
              }}
            >
              <div style={{
                padding: '16px 20px', borderBottom: '1px solid var(--border, #e5e7eb)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--bl-navy)' }}>
                  AP Email Preview
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                  padding: '3px 8px', borderRadius: 4,
                  background: 'var(--amber-tint, #fff8e1)', color: 'var(--amber, #d97706)',
                }}>
                  Review before sending
                </span>
              </div>

              <div style={{ padding: '16px 20px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: '8px 12px', fontSize: 13, marginBottom: 16 }}>
                  <span className="muted" style={{ fontWeight: 600 }}>To</span>
                  <span>{apTo}</span>
                  <span className="muted" style={{ fontWeight: 600 }}>CC</span>
                  <span>{apCc}</span>
                  <span className="muted" style={{ fontWeight: 600 }}>Subject</span>
                  <span style={{ fontWeight: 600 }}>{subject}</span>
                  <span className="muted" style={{ fontWeight: 600 }}>Attach</span>
                  <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{inv.number}.pdf</span>
                </div>

                <div style={{
                  background: 'var(--bl-fog, #f5f5f5)', borderRadius: 8,
                  padding: '14px 16px', fontSize: 13, lineHeight: 1.6,
                  whiteSpace: 'pre-wrap', color: 'var(--text, #333)',
                  border: '1px solid var(--border, #e5e7eb)',
                }}>
                  {body}
                </div>

                <div style={{ marginTop: 12, fontSize: 12 }}>
                  <span className="muted">Invoice: </span>
                  <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>{inv.number}</span>
                  <span className="muted"> · BAM: </span>
                  <span style={{ fontWeight: 600 }}>{inv.bam}</span>
                  <span className="muted"> · Amount: </span>
                  <span style={{ fontWeight: 600 }}>{inv.amount}</span>
                </div>
              </div>

              <div style={{
                padding: '12px 20px', borderTop: '1px solid var(--border, #e5e7eb)',
                display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center',
              }}>
                <button className="btn-ghost" onClick={() => setApPreview(null)}>
                  Cancel
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => confirmSendAp('mirae.lee@ilovesalt.com')}
                  disabled={apPreview.sending}
                  style={{ color: 'var(--bl-blue)', borderColor: 'var(--bl-blue)' }}
                >
                  Test send to me
                </button>
                <button
                  onClick={() => confirmSendAp()}
                  disabled={apPreview.sending}
                  style={{ background: 'var(--bl-blue)' }}
                >
                  {apPreview.sending ? 'Sending…' : 'Send to AP'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </>
  )
}
