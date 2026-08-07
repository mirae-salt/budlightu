'use client'

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { type InvoiceRow } from '../_lib/dummy'

type Row = InvoiceRow & { id: string; cohort_id: string | null; period: string }

/**
 * 0018_invoice_engine_fixes.sql added 'approved' to the invoices status CHECK
 * (plus approved_at / approved_by). This page typed status as
 * 'draft' | 'sent' | 'void' and only listed status === 'draft', so after a batch
 * approve the invoices vanished from the batch view with no way to act on them.
 * 'approved' and 'paid' are both first-class states here now.
 */
type DbInvoice = {
  id: string
  invoice_number: string
  period: string
  status: 'draft' | 'approved' | 'sent' | 'paid' | 'void'
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
  // Approved but not yet sent to AP. batch-approve only records the approval
  // AFTER the AP send succeeds, so a row sitting here means the send failed and
  // needs a retry. It must stay visible and actionable.
  const approvedUnsent = invoices.filter(inv => inv.status === 'approved')
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
    a.download = `${inv.bam} - ${inv.number}.pdf`
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
        <div style={{
          padding: '8px 14px', marginBottom: 16, borderRadius: 6, fontSize: 12, color: 'var(--midgray)',
          background: day < deadlineDay ? 'rgba(0,163,224,0.06)' : day <= generateDay ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.06)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {day < deadlineDay
            ? <><strong style={{ color: 'var(--bl-navy)' }}>{currentMonth}</strong> Receipt deadline {deadlineDay}th ({daysLeft}d left) · <strong>Auto-generate on {generateDay}th</strong></>
            : day <= generateDay
            ? <><strong style={{ color: 'var(--bl-navy)' }}>{currentMonth}</strong> Deadline passed · <strong>Auto-generate today</strong></>
            : <><strong style={{ color: 'var(--bl-navy)' }}>{currentMonth}</strong> Invoices generated · Review and approve</>}
        </div>

        <div className="surface-header">
          <div className="surface-title">
            Batch approval
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>{invoices.length} invoices · <strong>${total.toFixed(2)}</strong></span>
            {approvedUnsent.length > 0 && (
              <span className="badge badge-yellow" style={{ fontSize: 10 }}>
                {approvedUnsent.length} approved, not sent to AP
              </span>
            )}
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
              <th>BAM</th><th>Period</th><th style={{ textAlign: 'right' }}>Amount</th><th>Receipt</th><th>Status</th><th style={{ textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map(inv => {
              const receiptOk = inv.receiptStatus === 'auto_pass' || inv.receiptStatus === 'approved'
              const receiptPending = inv.receiptStatus === 'review'
              const receiptBad = inv.receiptStatus === 'rejected'

              return (
              <Fragment key={inv.number}>
                <tr style={{ borderLeft:
                  inv.status === 'void' ? '3px solid var(--red, #ef4444)'
                  : inv.status === 'sent' || inv.status === 'paid' ? '3px solid var(--green, #22c55e)'
                  : inv.status === 'approved' ? '3px solid var(--bl-blue, #0073cf)'
                  : receiptPending ? '3px solid var(--amber, #f59e0b)'
                  : '3px solid transparent' }}>
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
                  <td>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{inv.bam}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--midgray)' }}>{inv.number}</div>
                  </td>
                  <td className="muted" style={{ fontSize: 13 }}>{periodLabel(inv.period)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: 14 }}>{inv.amount}</td>
                  <td>
                    {receiptOk
                      ? <span className="badge badge-green" style={{ fontSize: 10 }}>{inv.receiptTotal}</span>
                      : receiptPending
                      ? <span className="badge badge-yellow" style={{ fontSize: 10 }}>pending</span>
                      : receiptBad
                      ? <span className="badge badge-red" style={{ fontSize: 10 }}>rejected</span>
                      : <span className="muted" style={{ fontSize: 11 }}>—</span>}
                  </td>
                  <td>
                    {inv.status === 'void'
                      ? <span className="badge badge-red">VOID</span>
                      : inv.status === 'paid'
                      ? <span className="badge badge-green">PAID</span>
                      : inv.status === 'sent'
                      ? <span className="badge badge-green">SENT</span>
                      : inv.status === 'approved'
                      ? <span className="badge badge-blue" title="Approved. Not confirmed as sent to AP yet.">APPROVED</span>
                      : <span className="badge badge-yellow">DRAFT</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {inv.status === 'void' ? (
                      <span className="muted" style={{ fontSize: 11 }}>Voided</span>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end' }}>
                        <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => previewPdf(inv)} title="Preview & download PDF">
                          {previewNumber === inv.number ? 'Close' : 'PDF'}
                        </button>
                        {(inv.status === 'draft' || inv.status === 'approved') && (
                          <button
                            className="btn-ghost"
                            style={{ padding: '3px 8px', fontSize: 11 }}
                            onClick={() => openApPreview(inv)}
                            title={inv.status === 'approved'
                              ? 'Approved but not marked sent. Retry the AP send.'
                              : 'Send to AP'}
                          >
                            {inv.status === 'approved' ? 'Retry AP' : 'Send AP'}
                          </button>
                        )}
                        <button
                          className="btn-ghost"
                          style={{ padding: '2px 6px', fontSize: 11, color: 'var(--midgray)', opacity: 0.5 }}
                          onClick={() => startVoid(inv.number)}
                          title="Void invoice"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </td>
                </tr>

                {previewNumber === inv.number && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                        <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => downloadOne(inv)}>
                          Download PDF
                        </button>
                      </div>
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
                    <td colSpan={7} style={{ background: 'var(--bl-silver)', padding: 16 }}>
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
              )
            })}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state" style={{ padding: '28px 16px', textAlign: 'center', fontSize: 13, color: 'var(--midgray)' }}>
                    No invoices yet. <strong>Auto-generated on the 16th</strong> after receipt review.
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
