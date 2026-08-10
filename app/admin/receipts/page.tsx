'use client'

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { REVIEW_QUEUE, DECIDED_RECEIPTS, type ReceiptRow } from '../_lib/dummy'

type Row = ReceiptRow & { id: string; storageKey?: string; storageMime?: string; ocrJson?: OcrData | null }

type OcrData = {
  store?: string
  date?: string
  lines?: Array<{ desc: string; qty: number; unit: number; total: number; is_bud_light: boolean; confidence: number; ambiguous?: boolean; reason?: string }>
  subtotal?: number
  tax?: number
  grand_total?: number
  bud_light_total_incl_tax?: number
  overall_confidence?: number
  notes?: string
}

type DbReceipt = {
  id: string
  status: 'pending' | 'review' | 'ocr_failed' | 'approved' | 'rejected' | 'auto_pass'
  uploaded_at: string
  bud_light_total_incl_tax: number | null
  ambiguous_flags: unknown
  decided_at: string | null
  decision_reason: string | null
  storage_key: string | null
  storage_mime: string | null
  ocr_json: OcrData | null
  bams: { first_name: string; last_name: string } | null
}

function reasonFor(r: DbReceipt): string {
  if (r.status === 'pending') return 'Awaiting OCR processing'
  if (r.status === 'ocr_failed') return r.decision_reason || 'OCR failed. Needs manual review or retry'
  if (r.status === 'auto_pass') return r.decision_reason || 'Auto-approved. Meets all criteria'
  if (r.decision_reason) return r.decision_reason
  const flags = r.ambiguous_flags
  if (Array.isArray(flags) && flags.length > 0) {
    return flags.map(f => String(f)).join('; ')
  }
  return 'Flagged for review'
}

function mapDbReceipt(r: DbReceipt): Row {
  return {
    id: r.id,
    bam: r.bams ? `${r.bams.first_name} ${r.bams.last_name}` : '—',
    uploadedAt: new Date(r.uploaded_at).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }),
    total: r.bud_light_total_incl_tax != null ? `$${Number(r.bud_light_total_incl_tax).toFixed(2)}` : '—',
    reason: reasonFor(r),
    status: r.status,
    decidedAt: r.decided_at ? new Date(r.decided_at).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }) : undefined,
    decidedReason: r.decision_reason ?? undefined,
    storageKey: r.storage_key ?? undefined,
    storageMime: r.storage_mime ?? undefined,
    ocrJson: r.ocr_json ?? undefined,
  }
}

type Tab = 'queue' | 'history'

export default function ReceiptsQueue() {
  const [queue, setQueue] = useState<Row[]>([])
  const [history, setHistory] = useState<Row[]>([])
  const [useDb, setUseDb] = useState(false)
  const [tab, setTab] = useState<Tab>('queue')
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [amountOverride, setAmountOverride] = useState('')
  const [retrying, setRetrying] = useState<string | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  const loadAll = () => {
    fetch('/api/admin/data?table=receipts')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          const all = (data as DbReceipt[]).map(mapDbReceipt)
          setQueue(all.filter(r => r.status === 'pending' || r.status === 'review' || r.status === 'ocr_failed'))
          setHistory(all.filter(r => r.status === 'approved' || r.status === 'rejected' || r.status === 'auto_pass'))
          setUseDb(true)
        } else {
          setQueue([])
          setHistory([])
        }
      })
      .catch(() => {
        setQueue([])
        setHistory([])
      })
  }

  useEffect(() => { loadAll() }, [])

  // Poll while any receipt is pending OCR
  useEffect(() => {
    if (!queue.some(r => r.status === 'pending')) return
    const timer = setInterval(loadAll, 5000)
    return () => clearInterval(timer)
  }, [queue])

  const pendingCount   = queue.filter(r => r.status === 'pending').length
  const reviewCount    = queue.filter(r => r.status === 'review').length
  const ocrFailedCount = queue.filter(r => r.status === 'ocr_failed').length
  const approvedCount  = history.filter(r => r.status === 'approved' || r.status === 'auto_pass').length
  const rejectedCount  = history.filter(r => r.status === 'rejected').length

  function toggleOpen(i: number) {
    setOpenIdx(openIdx === i ? null : i)
    setConfirming(null)
    setReason('')
    // Never let a corrected amount typed for one receipt survive into another.
    setAmountOverride('')
  }

  function decide(action: 'approve' | 'reject') {
    setConfirming(action)
    setReason(action === 'approve' ? 'Meets Bud Light reimbursement criteria' : 'Not a Bud Light purchase')
    setAmountOverride('')
  }

  async function confirmDecision(i: number, action: 'approve' | 'reject') {
    const row = queue[i]

    // Amount correction. The API has supported `override_total` since the
    // touchpoint-1 work, but nothing ever sent it, so Robin could only approve or
    // reject the number the model produced. That matters most on a mixed receipt:
    // when the reported tax-inclusive figure cannot be corroborated, the classifier
    // deliberately stores the PRE-TAX Bud Light sum and routes to review *on the
    // assumption that an admin will correct it here*. Without this field the
    // student was reimbursed the pre-tax figure, short by the tax.
    let overrideTotal: number | undefined
    if (action === 'approve' && amountOverride.trim() !== '') {
      const parsed = Number(amountOverride.trim())
      if (!Number.isFinite(parsed) || parsed < 0) {
        setMessage('Corrected amount must be a non-negative number')
        setTimeout(() => setMessage(null), 5000)
        return
      }
      overrideTotal = Math.round(parsed * 100) / 100
    }

    const effectiveReason = reason.trim() || (action === 'approve' ? 'Approved by admin' : 'Rejected by admin')

    try {
      const res = await fetch('/api/admin/receipts/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receipt_id: row.id,
          decision: action === 'approve' ? 'approved' : 'rejected',
          reason: effectiveReason,
          ...(overrideTotal !== undefined ? { override_total: overrideTotal } : {})
        })
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) {
        setMessage(json.message || json.error || 'Decision failed')
        setTimeout(() => setMessage(null), 5000)
        return
      }
      const decided: Row = {
        ...row,
        status: action === 'approve' ? 'approved' : 'rejected',
        decidedAt: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        decidedReason: reason.trim() || (action === 'approve' ? 'Approved by admin' : 'Rejected by admin')
      }
      setQueue(q => q.filter((_, idx) => idx !== i))
      setHistory(h => [decided, ...h])
      setOpenIdx(null)
      setConfirming(null)
      setAmountOverride('')
      // Report what the server said it recorded. The old text asserted
      // "Reimbursement confirmed" unconditionally, including on the path where
      // decide skips the ledger entirely (a receipt with no amount), so Robin was
      // told a reimbursement existed when none had been written.
      if (action === 'reject') {
        setMessage(json.bam_notified === false
          ? 'Rejected. Could not email the BAM.'
          : 'Rejected. BAM will be notified')
      } else if (typeof json.ledger_paid_cad === 'number') {
        setMessage(`Approved. Reimbursement recorded: $${json.ledger_paid_cad.toFixed(2)}`
          + (json.override_applied ? ' (amount corrected)' : ''))
      } else {
        setMessage('Approved, but NO reimbursement was recorded for this receipt. Check the amount.')
      }
      setTimeout(() => setMessage(null), 4000)
    } catch {
      setMessage('Network error: decision not saved')
      setTimeout(() => setMessage(null), 5000)
    }
  }

  /**
   * Reopen a decided receipt. This used to only mutate local state, so it looked
   * like it worked and silently reverted on refresh. It now calls the server,
   * which also recomputes the reimbursement ledger.
   */
  async function revertToReview(row: Row) {
    const reason = window.prompt(
      `Reopen ${row.bam}'s receipt for another decision?\n\nWhy are you reopening it? (required, saved to the audit log)`
    )
    if (reason === null) return
    if (reason.trim().length < 3) {
      setMessage('Reopen cancelled: a reason is required')
      setTimeout(() => setMessage(null), 4000)
      return
    }

    try {
      const res = await fetch('/api/admin/receipts/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt_id: row.id, reason: reason.trim() })
      })
      const j = await res.json()
      if (!res.ok || !j.ok) {
        setMessage(`Reopen failed: ${j.message ?? j.error ?? res.status}`)
        setTimeout(() => setMessage(null), 6000)
        return
      }

      setHistory(h => h.filter(r => r.id !== row.id))
      setQueue(q => [...q, { ...row, status: 'review', decidedAt: undefined, decidedReason: undefined }])
      setMessage(
        j.warning
          ? `${row.bam} reopened, but ${j.warning}`
          : `${row.bam} reopened for review. Reimbursement now $${Number(j.ledger_paid_cad ?? 0).toFixed(2)}`
      )
      setTimeout(() => setMessage(null), 6000)
    } catch (e) {
      setMessage(`Reopen failed: ${(e as Error).message}`)
      setTimeout(() => setMessage(null), 6000)
    }
  }

  const activeList = tab === 'queue' ? queue : history

  return (
    <>
      <TopBar crumbs={['Receipts', tab === 'queue' ? 'Review queue' : 'History']} />

      <div className="surface">
        <div className="surface-header">
          <div style={{ display: 'flex', gap: 0 }}>
            <button
              className={tab === 'queue' ? 'btn-navy' : 'btn-ghost'}
              style={{ borderRadius: '8px 0 0 8px', fontSize: 13 }}
              onClick={() => { setTab('queue'); setOpenIdx(null); setConfirming(null) }}
            >
              Review queue ({queue.length})
            </button>
            <button
              className={tab === 'history' ? 'btn-navy' : 'btn-ghost'}
              style={{ borderRadius: '0 8px 8px 0', fontSize: 13 }}
              onClick={() => { setTab('history'); setOpenIdx(null); setConfirming(null) }}
            >
              History ({history.length})
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {tab === 'queue' ? (
              <>
                {pendingCount > 0 && <span className="badge badge-blue">PENDING · {pendingCount}</span>}
                <span className="badge badge-yellow">REVIEW · {reviewCount}</span>
                <span className="badge badge-red">OCR FAILED · {ocrFailedCount}</span>
              </>
            ) : (
              <>
                <span className="badge badge-green">APPROVED · {approvedCount}</span>
                <span className="badge badge-red">REJECTED · {rejectedCount}</span>
              </>
            )}
          </div>
        </div>

        {message && (
          <div className="badge badge-green" style={{ marginBottom: 12, display: 'inline-block' }}>{message}</div>
        )}

        <table className="admin-table">
          <thead>
            <tr>
              <th style={{ width: 52 }}></th>
              <th>BAM</th>
              <th>Uploaded</th>
              <th>BL Total</th>
              <th>{tab === 'queue' ? 'Reason' : 'Original reason'}</th>
              <th>Status</th>
              {tab === 'history' && <th>Decided</th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {activeList.map((r, i) => (
              <Fragment key={r.id}>
                <tr>
                  <td style={{ padding: '4px 6px' }}>
                    {r.storageKey ? (
                      <img
                        src={`/api/admin/receipts/image?key=${encodeURIComponent(r.storageKey)}`}
                        alt="Receipt"
                        onClick={() => setLightboxSrc(`/api/admin/receipts/image?key=${encodeURIComponent(r.storageKey!)}`)}
                        style={{
                          width: 40, height: 40, objectFit: 'cover',
                          borderRadius: 6, border: '1px solid var(--stone)',
                          cursor: 'pointer', transition: 'transform 0.15s',
                        }}
                        onMouseOver={e => (e.currentTarget.style.transform = 'scale(1.15)')}
                        onMouseOut={e => (e.currentTarget.style.transform = 'scale(1)')}
                      />
                    ) : (
                      <div style={{
                        width: 40, height: 40, borderRadius: 6,
                        border: '1px dashed var(--stone)', background: 'var(--bl-fog)',
                        display: 'grid', placeItems: 'center', fontSize: 10, color: 'var(--midgray)'
                      }}>—</div>
                    )}
                  </td>
                  <td style={{ fontWeight: 600 }}>{r.bam}</td>
                  <td className="muted">{r.uploadedAt}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ fontWeight: 600 }}>{r.total}</span>
                    {(r.status === 'review' || r.status === 'pending') && r.ocrJson?.overall_confidence != null && (
                      <div style={{ fontSize: 10, color: r.ocrJson.overall_confidence >= 0.8 ? 'var(--green)' : 'var(--amber)', marginTop: 1 }}>
                        {(r.ocrJson.overall_confidence * 100).toFixed(0)}% conf
                      </div>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 12.5, maxWidth: 320 }}>{r.reason}</td>
                  <td>
                    {r.status === 'pending'
                      ? <span className="badge badge-blue">PENDING</span>
                      : r.status === 'review'
                      ? <span className="badge badge-yellow">REVIEW</span>
                      : r.status === 'ocr_failed'
                      ? <span className="badge badge-red">OCR FAILED</span>
                      : r.status === 'approved'
                      ? <span className="badge badge-green">APPROVED</span>
                      : r.status === 'auto_pass'
                      ? <span className="badge badge-green">AUTO PASS</span>
                      : <span className="badge badge-red">REJECTED</span>}
                  </td>
                  {tab === 'history' && (
                    <td className="muted" style={{ fontSize: 12 }}>{r.decidedAt || '—'}</td>
                  )}
                  <td>
                    <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => toggleOpen(i)}>
                      {openIdx === i ? 'Close' : 'Open'}
                    </button>
                  </td>
                </tr>
                {openIdx === i && (
                  <tr>
                    <td colSpan={tab === 'history' ? 8 : 7} style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
                        {r.storageKey ? (
                          <div
                            onClick={() => setLightboxSrc(`/api/admin/receipts/image?key=${encodeURIComponent(r.storageKey!)}`)}
                            style={{ flexShrink: 0, cursor: 'pointer' }}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`/api/admin/receipts/image?key=${encodeURIComponent(r.storageKey)}`}
                              alt="Receipt"
                              style={{
                                width: 160, maxHeight: 220, objectFit: 'contain',
                                borderRadius: 8, border: '1px solid var(--stone)',
                                background: 'var(--stone-lt)', cursor: 'pointer'
                              }}
                            />
                          </div>
                        ) : (
                          <div
                            style={{
                              width: 160, height: 120, background: 'var(--stone-lt)',
                              border: '1px dashed var(--stone)', borderRadius: 8,
                              display: 'grid', placeItems: 'center', color: 'var(--midgray)', fontSize: 12, flexShrink: 0
                            }}
                          >
                            No image
                          </div>
                        )}
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>{r.bam} · {r.total}</div>
                          <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>{r.reason}</div>

                          {r.ocrJson && r.ocrJson.lines && (
                            <div style={{ marginBottom: 12 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--midgray)', marginBottom: 4 }}>
                                OCR Result {r.ocrJson.store && `| ${r.ocrJson.store}`} {r.ocrJson.date && `(${r.ocrJson.date})`}
                              </div>
                              <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%', maxWidth: 420 }}>
                                <thead>
                                  <tr style={{ borderBottom: '1px solid var(--stone)' }}>
                                    <th style={{ textAlign: 'left', padding: '3px 8px 3px 0', fontSize: 10, color: 'var(--midgray)' }}>Item</th>
                                    <th style={{ textAlign: 'right', padding: '3px 8px', fontSize: 10, color: 'var(--midgray)' }}>Total</th>
                                    <th style={{ textAlign: 'center', padding: '3px 8px', fontSize: 10, color: 'var(--midgray)' }}>BL?</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.ocrJson.lines.map((l, li) => (
                                    <tr key={li} style={{
                                      borderBottom: '1px solid var(--bl-fog)',
                                      background: l.is_bud_light ? 'var(--green-bg, #e6f4ea)' : 'transparent'
                                    }}>
                                      <td style={{ padding: '3px 8px 3px 0' }}>
                                        {l.desc}
                                        {l.ambiguous && <span style={{ color: 'var(--amber)', marginLeft: 4, fontSize: 10 }}>?</span>}
                                      </td>
                                      <td style={{ textAlign: 'right', padding: '3px 8px', fontVariantNumeric: 'tabular-nums' }}>${l.total.toFixed(2)}</td>
                                      <td style={{ textAlign: 'center', padding: '3px 8px' }}>
                                        {l.is_bud_light
                                          ? <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓</span>
                                          : <span style={{ color: 'var(--midgray)' }}>—</span>}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              <div style={{ fontSize: 11, marginTop: 6, color: 'var(--midgray)' }}>
                                BL total: <strong style={{ color: 'var(--text)' }}>${(r.ocrJson.bud_light_total_incl_tax ?? 0).toFixed(2)}</strong>
                                {' '} · Grand total: ${(r.ocrJson.grand_total ?? 0).toFixed(2)}
                                {' '} · Confidence: {((r.ocrJson.overall_confidence ?? 0) * 100).toFixed(0)}%
                              </div>
                            </div>
                          )}

                          {/* History tab: show decision details + revert */}
                          {tab === 'history' && (
                            <div style={{ marginBottom: 14 }}>
                              <div style={{ fontSize: 12, marginBottom: 2 }}>
                                <span style={{ fontWeight: 600, color: r.status === 'approved' ? 'var(--green)' : 'var(--red)' }}>
                                  {r.status === 'approved' ? 'Approved' : 'Rejected'}
                                </span>
                                <span className="muted"> · {r.decidedAt}</span>
                              </div>
                              {r.decidedReason && (
                                <div className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>
                                  &ldquo;{r.decidedReason}&rdquo;
                                </div>
                              )}
                              <button
                                className="btn-ghost"
                                style={{ marginTop: 10, fontSize: 12, color: 'var(--bl-blue)', borderColor: 'var(--bl-blue)' }}
                                onClick={() => revertToReview(r)}
                              >
                                Revert to review queue
                              </button>
                            </div>
                          )}

                          {/* Queue tab: approve/reject flow */}
                          {tab === 'queue' && confirming === null && (
                            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                              <button
                                style={{ background: 'var(--green)' }}
                                onClick={() => decide('approve')}
                              >
                                Approve
                              </button>
                              <button
                                style={{ background: 'var(--red)' }}
                                onClick={() => decide('reject')}
                              >
                                Reject
                              </button>
                              {(r.status === 'ocr_failed' || r.status === 'pending') && r.storageKey && (
                                <button
                                  className="btn-ghost"
                                  style={{ fontSize: 12 }}
                                  disabled={retrying === r.id}
                                  onClick={async () => {
                                    setRetrying(r.id)
                                    try {
                                      const res = await fetch('/api/admin/receipts/retry-ocr', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ receipt_id: r.id })
                                      })
                                      const json = await res.json().catch(() => ({}))
                                      setMessage(json.message || 'OCR retry queued')
                                    } catch {
                                      setMessage('Retry failed. Check server logs')
                                    }
                                    setRetrying(null)
                                    setTimeout(() => setMessage(null), 4000)
                                  }}
                                >
                                  {retrying === r.id ? 'Retrying…' : 'Retry OCR'}
                                </button>
                              )}
                            </div>
                          )}

                          {tab === 'queue' && confirming === 'approve' && (
                            <div className="card" style={{ maxWidth: 420, marginTop: 8 }}>
                              <div style={{ marginBottom: 10, fontSize: 13 }}>
                                Confirm approve reimbursement for <strong>{r.bam}</strong> ({r.total})?
                              </div>
                              <div className="field">
                                <label>Reason</label>
                                <input value={reason} onChange={e => setReason(e.target.value)} />
                              </div>

                              {/*
                                Amount correction. Without this the only choices were
                                approve the model's number or reject the receipt. On a
                                mixed receipt whose tax-inclusive figure could not be
                                corroborated, the classifier stores the PRE-TAX sum and
                                sends it here expecting a human to fix it, so approving
                                as-is underpaid the student by the tax.
                              */}
                              <div className="field">
                                <label>Corrected amount (optional)</label>
                                <input
                                  value={amountOverride}
                                  onChange={e => setAmountOverride(e.target.value.replace(/[^\d.]/g, ''))}
                                  inputMode="decimal"
                                  placeholder={r.total === '—' ? 'e.g. 113.00' : r.total.replace('$', '')}
                                />
                                <div className="muted" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.5 }}>
                                  Leave blank to reimburse {r.total === '—' ? 'nothing (no amount was read)' : r.total}.
                                  Enter the tax-inclusive Bud Light total from the receipt if that figure is wrong.
                                  Corrections are written to the audit log.
                                </div>
                              </div>

                              <div style={{ display: 'flex', gap: 8 }}>
                                <button style={{ background: 'var(--green)' }} onClick={() => confirmDecision(i, 'approve')}>
                                  {amountOverride.trim() ? `Approve at $${amountOverride.trim()}` : 'Confirm approve'}
                                </button>
                                <button className="btn-ghost" onClick={() => { setConfirming(null); setAmountOverride('') }}>Cancel</button>
                              </div>
                            </div>
                          )}

                          {tab === 'queue' && confirming === 'reject' && (
                            <div className="card" style={{ maxWidth: 420, marginTop: 8 }}>
                              <div style={{ marginBottom: 10, fontSize: 13 }}>
                                Confirm reject this receipt for <strong>{r.bam}</strong>? BAM will be notified.
                              </div>
                              <div className="field">
                                <label>Reason</label>
                                <input value={reason} onChange={e => setReason(e.target.value)} />
                              </div>
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button style={{ background: 'var(--red)' }} onClick={() => confirmDecision(i, 'reject')}>Confirm reject</button>
                                <button className="btn-ghost" onClick={() => setConfirming(null)}>Cancel</button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {activeList.length === 0 && (
              <tr>
                <td colSpan={tab === 'history' ? 8 : 7}>
                  <div className="empty-state">
                    {tab === 'queue' ? 'No receipts pending review.' : 'No decided receipts yet.'}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {lightboxSrc && (
        <div
          onClick={() => setLightboxSrc(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.8)', display: 'grid', placeItems: 'center',
            cursor: 'zoom-out', padding: 24,
          }}
        >
          <img
            src={lightboxSrc}
            alt="Receipt full size"
            onClick={e => e.stopPropagation()}
            style={{
              maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain',
              borderRadius: 12, boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
              cursor: 'default',
            }}
          />
          <button
            onClick={() => setLightboxSrc(null)}
            style={{
              position: 'absolute', top: 16, right: 24,
              background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8,
              color: '#fff', fontSize: 18, padding: '6px 14px', cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      )}
    </>
  )
}
