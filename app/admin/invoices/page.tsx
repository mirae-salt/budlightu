'use client'

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { Toast, type ToastNotice } from '../_components/Toast'
import { reasonProblem } from '@/lib/reason'
import { type InvoiceRow } from '../_lib/dummy'
import { useCohortFilter, CohortFilterBar } from '../_components/CohortFilter'

type PayloadLine = { qty: number; description: string; unitPrice: number; total: number }

type Row = InvoiceRow & {
  id: string
  cohort_id: string | null
  period: string
  /** Line items from payload_json. Banking is stripped server-side (redactPayload). */
  lines: PayloadLine[]
  subtotal?: number
  tax?: number
  /** Whether this invoice charges tax, and at what rate. Never the HST number. */
  taxApplicable: boolean
  /** PO number as stored on the invoice, so the preview shows what will be sent. */
  poNumber: string | null
  taxRate: number | null
}

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
  payload_json: { total?: number; subtotal?: number; tax?: number; lines?: PayloadLine[]; jobNumber?: string } | null
  bams: { first_name: string; last_name: string } | null
  receipt_status: string | null
  receipt_total: number | null
  tax_applicable?: boolean
  tax_rate?: number | null
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
    receiptTotal: inv.receipt_total != null ? `$${Number(inv.receipt_total).toFixed(2)}` : undefined,
    lines: Array.isArray(inv.payload_json?.lines) ? inv.payload_json!.lines! : [],
    subtotal: inv.payload_json?.subtotal,
    tax: inv.payload_json?.tax,
    taxApplicable: inv.tax_applicable === true,
    poNumber: inv.payload_json?.jobNumber ?? null,
    taxRate: inv.tax_rate ?? null
  }
}

/** Same predicate the server and the send-time ledger check use. */
function isReimbursementLine(line: { description?: string }): boolean {
  return typeof line?.description === 'string' && /reimbursement/i.test(line.description)
}

function money(n: number): string {
  return `$${n.toFixed(2)}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Editable copy of a line. Amounts are held as text so a half-typed value does
 *  not become NaN and silently show $0.00 while it is being typed. */
type LineDraft = { description: string; qty: string; unitPrice: string; locked: boolean }

function toDrafts(lines: PayloadLine[]): LineDraft[] {
  return lines.map(l => ({
    description: l.description ?? '',
    qty: String(l.qty ?? 1),
    unitPrice: Number(l.unitPrice ?? 0).toFixed(2),
    locked: isReimbursementLine(l)
  }))
}

function draftLineTotal(d: LineDraft): number {
  const qty = Number(d.qty)
  const unit = Number(d.unitPrice)
  if (!Number.isFinite(qty) || !Number.isFinite(unit)) return 0
  return round2(qty * unit)
}

/**
 * kind drives the badge colour. A failure must never render in a green badge:
 * "Void failed" and "AP send failed" both used to, on this page, which is the
 * bug that was just fixed across /admin/roster and /admin/cohorts.
 */
type Notice = ToastNotice

export default function InvoiceBatch() {
  /* The raw list. `invoices` below is the filtered view, and EVERY derived value
     hangs off that view on purpose: the count, the total, the CSV, the ZIP and
     the batch approval all act on exactly what is on screen. A filter that hid
     rows from the table but left them in "Approve selected" would be a way to
     send a payment you were not looking at. */
  const [allInvoices, setAllInvoices] = useState<Row[]>([])
  const [useDb, setUseDb] = useState(false)
  const [batchConfirming, setBatchConfirming] = useState(false)
  const [batchNotice, setBatchNotice] = useState<Notice | null>(null)
  const [previewNumber, setPreviewNumber] = useState<string | null>(null)
  const [voidingNumber, setVoidingNumber] = useState<string | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [rowNotice, setRowNotice] = useState<Notice | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  /** Same rule as the server, so the hint matches the eventual error. */
  const voidReasonIssue = reasonProblem(voidReason, 'Reason for voiding')

  /**
   * "Test send to me" used to post a hardcoded mirae.lee@ilovesalt.com, so Robin
   * clicking it mailed someone else. It now goes to whoever is signed in.
   */
  const [testSendAddress, setTestSendAddress] = useState<string | null>(null)

  // ── line editing (salary + ad-hoc only) ───────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null)
  const [lineDrafts, setLineDrafts] = useState<LineDraft[]>([])
  const [editReason, setEditReason] = useState('')
  const [savingLines, setSavingLines] = useState(false)

  /** Successes clear themselves; failures stay until the next action. */
  function reportBatch(kind: 'ok' | 'error', text: string) {
    const n = { kind, text }
    setBatchNotice(n)
    if (kind === 'ok') setTimeout(() => setBatchNotice(cur => (cur === n ? null : cur)), 6000)
  }

  function reportRow(kind: 'ok' | 'error', text: string) {
    const n = { kind, text }
    setRowNotice(n)
    if (kind === 'ok') setTimeout(() => setRowNotice(cur => (cur === n ? null : cur)), 6000)
  }

  useEffect(() => {
    fetch('/api/admin/data?table=invoices')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setAllInvoices((data as DbInvoice[]).map(mapDbInvoice))
          setUseDb(true)
        }
      })
      .catch(() => {})

    // Who "me" is, for the test send.
    fetch('/api/admin/team')
      .then(res => res.json())
      .then(j => { if (typeof j?.me?.email === 'string') setTestSendAddress(j.me.email) })
      .catch(() => {})
  }, [])

  const { cohortFilter, hideTest, setFilters, cohortOptions, matches } = useCohortFilter()
  const invoices = allInvoices.filter(inv => matches({ cohortId: inv.cohort_id ?? null }))

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
      reportBatch('ok', `${selectedDrafts.length} invoices approved. AP emails queued (dryrun mode). BAM copies queued.`)
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
        reportBatch('error', json.message || `Batch approve failed (${json.failures ?? '?'} of ${json.processed ?? '?'} failed)`)
      } else {
        // "N invoice(s) processed" was true and useless on a dryrun cohort: nothing was emailed and
        // the rows are still drafts. Say which it was, or the operator reasonably concludes the batch
        // is done and moves on.
        if (json.rehearsed > 0) {
          reportBatch(
            'ok',
            `Rehearsal: ${json.rehearsed} of ${json.processed ?? 0} checked and left as drafts. ` +
            'No email was sent. Set the cohort to live and run this again to send them.'
          )
        } else {
          reportBatch('ok', `Batch approve: ${json.processed ?? 0} invoice(s) sent and approved.`)
          setSelected(new Set())
        }
      }
    } catch {
      reportBatch('error', 'Network error: batch approve not sent')
    }
  }

  function startVoid(number: string) {
    setVoidingNumber(number)
    setVoidReason('')
    setPreviewNumber(null)
    setEditingId(null)
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); setPdfUrl(null) }
  }

  async function confirmVoid(inv: Row) {
    if (!useDb) {
      setAllInvoices(list => list.map(i => i.number === inv.number ? { ...i, status: 'void' as const } : i))
      setVoidingNumber(null)
      reportRow('ok', `${inv.number} voided (local preview only, no database).`)
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
        reportRow('error', json.message || json.error || 'Void failed')
      } else {
        setAllInvoices(list => list.map(i => i.id === inv.id ? { ...i, status: 'void' as const } : i))
        // The route says whether a cancellation draft actually exists. Claiming
        // one unconditionally is P1-16.
        reportRow('ok', `${inv.number} voided. ${json.note ?? ''}`.trim())
      }
    } catch {
      reportRow('error', 'Network error: void not saved')
    }
    setVoidingNumber(null)
  }

  // ── line editing ──────────────────────────────────────────────────────────

  function startEditLines(inv: Row) {
    if (editingId === inv.id) { setEditingId(null); return }
    setEditingId(inv.id)
    setLineDrafts(toDrafts(inv.lines))
    setEditReason('')
    setVoidingNumber(null)
    setPreviewNumber(null)
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); setPdfUrl(null) }
  }

  function updateDraft(i: number, patch: Partial<LineDraft>) {
    setLineDrafts(list => list.map((d, idx) => (idx === i ? { ...d, ...patch } : d)))
  }

  function addAdhocLine() {
    setLineDrafts(list => [...list, { description: '', qty: '1', unitPrice: '0.00', locked: false }])
  }

  function removeLine(i: number) {
    setLineDrafts(list => list.filter((_, idx) => idx !== i))
  }

  async function saveLines(inv: Row) {
    setSavingLines(true)
    try {
      const res = await fetch(`/api/admin/invoices/${inv.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: editReason,
          // No subtotal / tax / total is sent. The server recomputes them and
          // would ignore them anyway.
          lines: lineDrafts.map(d => ({
            description: d.description,
            qty: d.qty,
            unitPrice: d.unitPrice
          }))
        })
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) {
        reportRow('error', json.message || `Edit not saved (HTTP ${res.status}).`)
      } else {
        // Show what the SERVER stored, not what was typed.
        setAllInvoices(list => list.map(i => i.id === inv.id ? {
          ...i,
          lines: json.lines ?? i.lines,
          subtotal: json.subtotal,
          tax: json.tax,
          amount: `$${Number(json.total).toFixed(2)}`
        } : i))
        setEditingId(null)
        const warnings: string[] = Array.isArray(json.warnings) ? json.warnings : []
        const saved =
          `${json.invoice_number}: lines saved. Server total ${money(Number(json.total))}.` +
          (json.pdf_invalidated ? ' The stored PDF was cleared, so the next send re-renders it.' : '')
        // A caveat is not a success. It stays on screen, in red, and it says the
        // edit WAS saved so nobody re-submits it.
        if (warnings.length > 0) reportRow('error', `${saved} Needs attention: ${warnings.join(' ')}`)
        else reportRow('ok', saved)
      }
    } catch {
      reportRow('error', 'Network error: the edit was not saved.')
    }
    setSavingLines(false)
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
      reportRow('error', 'PDF generation failed')
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
        reportRow('error', 'ZIP download failed')
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
      reportRow('error', 'ZIP download failed. Check server logs')
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
        reportRow('error', 'AP email endpoint not configured yet.')
      } else if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        reportRow('error', `AP email failed: ${body.message ?? res.statusText}`)
      } else {
        const json = await res.json().catch(() => ({}))
        /*
         * READS `sent` AND `blocked`, not just `failed`.
         *
         * /api/admin/send-ap returns HTTP 200 with { ok:false, sent:0, blocked:1, failed:0 } when it
         * refuses. `failed` is 0 because the route computes it as
         * `outcomes.length - sent - blocked`. So this checked `res.ok` (true) and then `json.failed`
         * (0, falsy) and fell through to "sent to AP", flipping the row to `sent`. Nothing was sent.
         *
         * It refuses for real reasons in live too, not only for a dryrun cohort: a voided invoice, one
         * that is not approved, a missing PO, a payload that disagrees with the ledger, a malformed AP
         * address. Every one of those was reported to the operator as a completed send, which is the
         * version of this that loses an invoice: Robin believes AP has it and nobody chases it.
         *
         * `sent === 1` is now the ONLY thing that produces a success message or moves the row.
         */
        const outcome = Array.isArray(json.results) ? json.results[0] : undefined
        const reason = outcome?.error ?? json.message ?? 'no reason given'
        if (testEmail) {
          if (json.sent === 1) reportRow('ok', `Test email sent to ${testEmail}`)
          else reportRow('error', `Test send did not go out: ${reason}`)
        } else if (json.sent === 1) {
          reportRow('ok', `${inv.number} sent to AP.`)
          setAllInvoices(list => list.map(i => i.id === inv.id ? { ...i, status: 'sent' as const } : i))
        } else if (json.blocked) {
          // Not an error in the operator's sense: the system refused on purpose and the reason is the
          // useful part. Says NOT SENT explicitly, because that is the fact being corrected here.
          reportRow('error', `${inv.number} NOT sent: ${reason}`)
        } else {
          reportRow('error', `${inv.number} NOT sent: ${reason}`)
        }
      }
    } catch {
      reportRow('error', 'AP email endpoint not configured yet.')
    }
    setApPreview(null)
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
          {/* wrap, not nowrap: the count, an optional badge and three buttons in one row is
              already tight on a laptop, and on a phone this row alone was wider than the
              screen with nothing to contain it -- a second, independent source of the same
              whole-page horizontal scroll the table below caused. */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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

        {/* Sits above the batch controls, not below the table: the count and total in
            the header line describe the filtered view, and Approve acts on it. */}
        <CohortFilterBar
          cohortFilter={cohortFilter}
          hideTest={hideTest}
          setFilters={setFilters}
          cohortOptions={cohortOptions}
          showTestToggle={false}
        />

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

        {/*
          These were 11px inline badges beside the button that triggered them, so a
          failure was easy to walk past: the button looked finished and the reason sat
          below the fold. They are now fixed toasts. A failure stays until dismissed.
        */}
        <Toast notice={batchNotice} onDismiss={() => setBatchNotice(null)} />
        <Toast notice={rowNotice} onDismiss={() => setRowNotice(null)} />

        {/* Contained to this box, not the page -- see app/admin/unmatched/page.tsx for the
            fault this fixes: an unwrapped admin-table drags the whole page (sidebar included)
            sideways on a phone. This is the table Mirae's 2026-08-14 screenshots showed
            breaking, PDF/void buttons and all pushed off the right edge. */}
        <div className="table-scroll">
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
                            onClick={() => startEditLines(inv)}
                            disabled={!useDb || inv.lines.length === 0}
                            title={!useDb
                              ? 'Sample data only. Line editing needs the database.'
                              : inv.lines.length === 0
                              ? 'This invoice has no stored line items. Regenerate it first.'
                              : 'Edit the salary line and ad-hoc items. The reimbursement line is changed on the receipt.'}
                          >
                            {editingId === inv.id ? 'Close edit' : 'Edit lines'}
                          </button>
                        )}
                        {(inv.status === 'draft' || inv.status === 'approved') && (
                          <button
                            className="btn-ghost"
                            style={{ padding: '3px 8px', fontSize: 11 }}
                            onClick={() => openApPreview(inv)}
                            title={inv.status === 'approved'
                              ? 'Approved but not marked sent. Retry the AP send.'
                              : 'Test send only. Run batch approval before this invoice can go to AP.'}
                          >
                            {inv.status === 'approved' ? 'Retry AP' : 'Test AP'}
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

                {editingId === inv.id && (() => {
                  const previewSubtotal = round2(lineDrafts.reduce((s, d) => s + draftLineTotal(d), 0))
                  const rate = inv.taxApplicable ? inv.taxRate : 0
                  const previewTax = rate == null ? null : round2(previewSubtotal * rate)
                  const previewTotal = previewTax == null ? null : round2(previewSubtotal + previewTax)
                  // Shared rule, so the message matches what the server would say.
                  const reasonIssue = reasonProblem(editReason, 'Reason for the change')
                  const reasonOk = reasonIssue === null
                  const emptyDesc = lineDrafts.some(d => d.description.trim().length === 0)
                  const badNumber = lineDrafts.some(d =>
                    !/^\d{1,3}$/.test(d.qty.trim()) || !Number.isFinite(Number(d.unitPrice)) || d.unitPrice.trim() === '' || Number(d.unitPrice) < 0
                  )
                  return (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      <div className="card" style={{ maxWidth: 760 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--bl-navy)', marginBottom: 4 }}>
                          Edit lines · {inv.number} ({inv.bam})
                        </div>
                        <p className="muted" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
                          Salary and ad-hoc items (bar tab, gas, event costs) are edited here. The reimbursement line is
                          read-only: that amount comes from the receipt, so change it on{' '}
                          <a href="/admin/receipts">/admin/receipts</a> and regenerate.
                        </p>

                        <table className="admin-table" style={{ marginBottom: 12 }}>
                          <thead>
                            <tr>
                              <th>Description</th>
                              <th style={{ width: 70 }}>Qty</th>
                              <th style={{ width: 110 }}>Unit price</th>
                              <th style={{ width: 100, textAlign: 'right' }}>Line total</th>
                              <th style={{ width: 40 }}></th>
                            </tr>
                          </thead>
                          <tbody>
                            {lineDrafts.map((d, i) => (
                              <tr key={i}>
                                <td>
                                  {d.locked ? (
                                    <div>
                                      <div style={{ fontSize: 13 }}>{d.description}</div>
                                      <div className="muted" style={{ fontSize: 11 }}>
                                        Reimbursement. Changed on the receipt, not here.
                                      </div>
                                    </div>
                                  ) : (
                                    <input
                                      value={d.description}
                                      maxLength={120}
                                      placeholder="e.g. Event bar tab, approved by the program manager"
                                      onChange={e => updateDraft(i, { description: e.target.value })}
                                      style={{ width: '100%' }}
                                    />
                                  )}
                                </td>
                                <td>
                                  {d.locked
                                    ? <span style={{ fontSize: 13 }}>{d.qty}</span>
                                    : <input
                                        value={d.qty}
                                        inputMode="numeric"
                                        onChange={e => updateDraft(i, { qty: e.target.value })}
                                        style={{ width: '100%' }}
                                      />}
                                </td>
                                <td>
                                  {d.locked
                                    ? <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{money(Number(d.unitPrice))}</span>
                                    : <input
                                        value={d.unitPrice}
                                        inputMode="decimal"
                                        onChange={e => updateDraft(i, { unitPrice: e.target.value })}
                                        style={{ width: '100%' }}
                                      />}
                                </td>
                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                                  {money(draftLineTotal(d))}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  {d.locked ? (
                                    <span className="muted" style={{ fontSize: 11 }}>locked</span>
                                  ) : (
                                    <button
                                      className="btn-ghost"
                                      style={{ padding: '2px 6px', fontSize: 11, color: 'var(--midgray)' }}
                                      onClick={() => removeLine(i)}
                                      title="Remove this line"
                                      disabled={lineDrafts.length <= 1}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 12 }}>
                          <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={addAdhocLine} disabled={lineDrafts.length >= 12}>
                            + Add ad-hoc line
                          </button>
                          <div style={{ fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            <div><span className="muted">Subtotal </span><strong>{money(previewSubtotal)}</strong></div>
                            <div>
                              <span className="muted">Tax </span>
                              <strong>
                                {!inv.taxApplicable ? '$0.00' : previewTax == null ? 'unknown' : money(previewTax)}
                              </strong>
                              {inv.taxApplicable && previewTax == null && (
                                <span className="muted" style={{ fontSize: 11 }}> (province code not recognised)</span>
                              )}
                            </div>
                            <div style={{ fontSize: 15 }}>
                              <span className="muted">Total </span>
                              <strong>{previewTotal == null ? 'unknown' : money(previewTotal)}</strong>
                            </div>
                            <div className="muted" style={{ fontSize: 11, maxWidth: 280, lineHeight: 1.4, marginTop: 4 }}>
                              Preview only. The server recomputes the subtotal, tax and total from the lines and stores
                              its own figures.
                            </div>
                          </div>
                        </div>

                        <div className="field">
                          <label>Why are the amounts changing?</label>
                          <input
                            placeholder="e.g. Program manager approved $60 bar tab for the Sept 12 event"
                            value={editReason}
                            maxLength={500}
                            onChange={e => setEditReason(e.target.value)}
                          />
                          {!reasonOk && reasonIssue && (
                            <span className="muted" style={{ fontSize: 11, color: 'var(--amber)' }}>
                              {reasonIssue}
                            </span>
                          )}
                        </div>

                        {emptyDesc && (
                          <div className="muted" style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 8 }}>
                            Every line needs a description.
                          </div>
                        )}
                        {badNumber && (
                          <div className="muted" style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 8 }}>
                            Quantity must be a whole number and the unit price must be zero or more.
                          </div>
                        )}

                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            onClick={() => saveLines(inv)}
                            disabled={savingLines || !reasonOk || emptyDesc || badNumber}
                          >
                            {savingLines ? 'Saving…' : 'Save lines'}
                          </button>
                          <button className="btn-ghost" onClick={() => setEditingId(null)} disabled={savingLines}>Cancel</button>
                          <span className="muted" style={{ fontSize: 11, lineHeight: 1.4 }}>
                            Saving clears the stored PDF so the next send re-renders it from these lines.
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                  )
                })()}

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
                          {voidReason.trim().length > 0 && voidReasonIssue && (
                            <span className="muted" style={{ fontSize: 11, color: 'var(--amber)' }}>
                              {voidReasonIssue}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            style={{ background: 'var(--red)' }}
                            disabled={voidReasonIssue !== null}
                            title={voidReasonIssue ?? undefined}
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
      </div>

      {apPreview && (() => {
        const inv = apPreview.inv
        const period = new Date(inv.period)
        const month = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
        const apTo = 'accounts.payable@ilovesalt.com'
        const apCc = 'robin.graham@ilovesalt.com, nb@ilovesalt.com'
        const subject = `${inv.bam} ${month} Invoice #${inv.number}`
        // The preview must show the PO number that will actually be sent. It used to
        // print the literal "PO# (see cohort config)", so Robin reviewed a body that
        // differs from the real email in exactly the field AP keys payment off.
        const po = inv.poNumber
        const body = `Hi there,\n\nAttached is a ${month} invoice for our Bud Light BAM.\nPlease maintain net15 payment terms with direct deposit.\n\nThis is from BUD LIGHT U - PO# ${po ?? '(not set on this cohort — the send will be blocked)'}.\n\nThanks,\nProgram Team`
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
                // 560 was too narrow for the footer buttons and forced them to wrap.
                maxWidth: 720, width: '100%', overflow: 'hidden',
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

              {/*
                Footer was one flex row holding a paragraph and three buttons, so at
                560px the buttons collapsed to three wrapped lines each. The note now
                sits on its own row above the buttons, and every button gets
                `whiteSpace: nowrap` so its label cannot break mid-word.
              */}
              <div style={{
                padding: '12px 20px', borderTop: '1px solid var(--border, #e5e7eb)',
                display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                {inv.status !== 'approved' && (
                  <span className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                    This invoice is not approved yet. Test sends are allowed; run batch approval before sending to AP.
                  </span>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                  <button className="btn-ghost" onClick={() => setApPreview(null)} style={{ whiteSpace: 'nowrap' }}>
                    Cancel
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={() => confirmSendAp(testSendAddress ?? undefined)}
                    disabled={apPreview.sending || !testSendAddress}
                    title={testSendAddress
                      ? `Sends this exact email to ${testSendAddress} instead of AP`
                      : 'Sign in to use a test send'}
                    style={{ color: 'var(--bl-blue)', borderColor: 'var(--bl-blue)', whiteSpace: 'nowrap' }}
                  >
                    Test send to me
                  </button>
                  <button
                    onClick={() => confirmSendAp()}
                    disabled={apPreview.sending || inv.status !== 'approved'}
                    title={inv.status !== 'approved'
                      ? 'Only an approved invoice can go to AP. Run batch approval first.'
                      : undefined}
                    style={{ background: 'var(--bl-blue)', whiteSpace: 'nowrap' }}
                  >
                    {apPreview.sending ? 'Sending…' : 'Send to AP'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </>
  )
}
