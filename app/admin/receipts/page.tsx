'use client'
import { QueueLink } from '../_components/QueueLink'

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { Toast, type ToastNotice } from '../_components/Toast'
import { useCohortFilter, CohortFilterBar } from '../_components/CohortFilter'
import { parseReason } from '@/lib/receipt-reason'
import { formatLineTotal } from '@/lib/format-line-total'
import { REVIEW_QUEUE, DECIDED_RECEIPTS, type ReceiptRow } from '../_lib/dummy'
import { reasonProblem, MIN_REASON_LENGTH } from '@/lib/reason'
/**
 * The same pure functions the decide route uses, so the preview below is produced by
 * the code that will produce the stored amount. Nothing here does tax arithmetic:
 * applyBudLightCorrection re-runs recomputeBudLightTotal (lib/classify-receipt), which
 * is the one tested place that decides the tax basis. The server recomputes anyway and
 * its answer is what gets reported after approval.
 */
import { applyBudLightCorrection, currentBudLightIndices } from '@/lib/receipt-correction'

type Row = ReceiptRow & {
  id: string
  cohortId: string | null
  isTest: boolean
  storageKey?: string
  storageMime?: string
  storageBytes?: number | null
  ocrJson?: OcrData | null
  /** the stored amount as a number, for the correction preview delta */
  totalCad?: number | null
  /** When it was decided, else when it was uploaded. History is ordered on this, newest first. */
  sortMs: number
}

type OcrData = {
  store?: string
  date?: string
  lines?: Array<{ desc: string; qty: number | null; unit: number | null; total: number | null; is_bud_light: boolean; confidence: number; ambiguous?: boolean; reason?: string }>
  subtotal?: number
  tax?: number
  grand_total?: number
  bud_light_total_incl_tax?: number
  overall_confidence?: number
  notes?: string
  /**
   * Written by the decide route when an admin corrects which lines are Bud Light.
   * Its presence means `lines[].is_bud_light` above is a human answer, not the AI's,
   * so "Reset to what the AI read" would be a false label. `model_classification`
   * holds the AI original.
   */
  admin_classification?: { corrected_at?: string; corrected_by?: string; bud_light_lines?: number[] }
  model_classification?: { captured_at?: string; bud_light_total_incl_tax?: number | null }
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
  storage_bytes: number | null
  cohort_id: string | null
  ocr_json: OcrData | null
  bams: { first_name: string; last_name: string; is_test: boolean | null } | null
}

/**
 * The URL for one receipt image.
 *
 * ONE BUILDER, four call sites (thumbnail and lightbox, in both the row and the expanded
 * detail). The URL was inlined at each of them, which is how two of them end up drifting:
 * add `name` to three and the fourth quietly saves files without it.
 *
 * `name` is only a label for the download filename. The month comes from the storage key
 * on the server, so a missing or dashed-out name still gives a well-named file.
 */
function receiptImageUrl(storageKey: string, bam?: string): string {
  const base = `/api/admin/receipts/image?key=${encodeURIComponent(storageKey)}`
  // '—' is the table's placeholder for an unresolved BAM, not a name.
  return bam && bam !== '—' ? `${base}&name=${encodeURIComponent(bam)}` : base
}

/*
 * A receipt is not always a photo. Uploads accept PDF, and every render site here was an
 * <img>, so Kennedy Cober's 860 KB PDF showed as a broken image in the thumbnail, the
 * expanded row and the lightbox alike. Robin could not see the receipt she was being
 * asked to decide on, and nothing on screen said why.
 */
function isPdfReceipt(mime?: string): boolean {
  return (mime ?? '').toLowerCase().startsWith('application/pdf')
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
    cohortId: r.cohort_id ?? null,
    isTest: r.bams?.is_test === true,
    sortMs: Date.parse(r.decided_at ?? r.uploaded_at),
    bam: r.bams ? `${r.bams.first_name} ${r.bams.last_name}` : '—',
    uploadedAt: new Date(r.uploaded_at).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }),
    total: r.bud_light_total_incl_tax != null ? `$${Number(r.bud_light_total_incl_tax).toFixed(2)}` : '—',
    totalCad: r.bud_light_total_incl_tax != null && Number.isFinite(Number(r.bud_light_total_incl_tax))
      ? Number(r.bud_light_total_incl_tax)
      : null,
    reason: reasonFor(r),
    status: r.status,
    decidedAt: r.decided_at ? new Date(r.decided_at).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }) : undefined,
    decidedReason: r.decision_reason ?? undefined,
    storageKey: r.storage_key ?? undefined,
    storageMime: r.storage_mime ?? undefined,
    storageBytes: r.storage_bytes ?? null,
    ocrJson: r.ocr_json ?? undefined,
  }
}

/**
 * One finding per line, with the machine code turned into a short label.
 *
 * A stored reason joins every check that fired with " | ", so rendered as plain text two
 * separate problems look like one sentence and the codes read as noise. Nothing is
 * dropped: free-text clauses with no code show as their own line, and the full stored
 * string stays in the database untouched.
 */
function ReasonList(
  { reason, compact = false, storageBytes }:
  { reason: string; compact?: boolean; storageBytes?: number | null }
) {
  const parts = parseReason(reason, { storageBytes })
  if (parts.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 4 : 6 }}>
      {parts.map((p, i) => (
        <div key={i} style={{ lineHeight: 1.45 }}>
          {/* A real space, not only a margin: a margin does not survive being copied
              out of the table or read aloud by a screen reader. */}
          {p.label && (
            <>
              <span style={{ fontWeight: 600, color: 'var(--bl-navy)' }}>{p.label}</span>{' '}
            </>
          )}
          <span>{p.detail}</span>
        </div>
      ))}
    </div>
  )
}

type Tab = 'queue' | 'history'

export default function ReceiptsQueue() {
  /*
   * One raw list, with `queue` and `history` derived from it.
   *
   * They used to be two pieces of state, and the row actions index into them
   * (`const row = queue[i]`). The moment a filter hides a row, an index taken from
   * what is on screen stops matching the array being indexed, and Approve acts on
   * somebody else's receipt. Deriving both lists from one source keeps the rendered
   * list and the indexed list the same object, so that cannot happen.
   */
  const [allRows, setAllRows] = useState<Row[]>([])
  const [useDb, setUseDb] = useState(false)
  const [tab, setTab] = useState<Tab>('queue')
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null)
  /**
   * Was a plain string always rendered in a GREEN badge, so "Decision failed",
   * "Reopen failed" and "Retry failed" all looked like successes. Carries a kind
   * now, and only a success clears itself.
   */
  const [notice, setNotice] = useState<ToastNotice | null>(null)
  function notify(kind: 'ok' | 'error', text: string) {
    const n: ToastNotice = { kind, text }
    setNotice(n)
    if (kind === 'ok') setTimeout(() => setNotice(cur => (cur === n ? null : cur)), 6000)
  }
  const [reason, setReason] = useState('')
  const [amountOverride, setAmountOverride] = useState('')
  const [retrying, setRetrying] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; pdf: boolean } | null>(null)
  /**
   * Corrected Bud Light ticks for the row that is open. Only one row expands at a
   * time, so it is keyed by receipt id rather than kept per row: a selection must
   * never leak from one student's receipt onto another's.
   */
  const [blSelection, setBlSelection] = useState<{ id: string; indices: number[] } | null>(null)

  /*
   * Upload on behalf of a student, for a month that has already closed.
   *
   * The API has allowed admin-on-behalf uploads for a while (app/api/portal/upload
   * checks requireAdmin), but nothing in admin ever called it, and the closed-month
   * refusal applied to that path exactly like it does to the student's own upload.
   * lib/period.ts's own message has promised an exception ("ask on the Support
   * page") since 2026-08-14 with no way to act on it. This panel is that way in,
   * scoped to what validatePeriod's allowClosedOverride actually allows: a real
   * receipt for a real, past month -- not a future one, not one outside the BAM's
   * program.
   */
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overrideBams, setOverrideBams] = useState<{ id: string; name: string; cohortId: string | null; isTest: boolean }[]>([])
  const [overrideSearch, setOverrideSearch] = useState('')
  const [overrideBamId, setOverrideBamId] = useState('')
  const [overridePeriod, setOverridePeriod] = useState('')
  const [overrideReasonText, setOverrideReasonText] = useState('')
  const [overrideFile, setOverrideFile] = useState<File | null>(null)
  const [overrideBusy, setOverrideBusy] = useState(false)

  useEffect(() => {
    if (!overrideOpen || overrideBams.length > 0) return
    fetch('/api/admin/data?table=bams')
      .then(res => res.json())
      .then(({ data }: { data: Array<{ id: string; first_name: string; last_name: string; cohort_id: string | null; is_test: boolean; status: string }> | null }) => {
        setOverrideBams(
          (data ?? [])
            .filter(b => b.status === 'active')
            .map(b => ({ id: b.id, name: `${b.first_name} ${b.last_name}`, cohortId: b.cohort_id, isTest: b.is_test }))
            .sort((a, b) => a.name.localeCompare(b.name))
        )
      })
      .catch(() => setOverrideBams([]))
  }, [overrideOpen, overrideBams.length])

  const overrideMatches = overrideSearch.trim()
    ? overrideBams.filter(b => b.name.toLowerCase().includes(overrideSearch.trim().toLowerCase()))
    : overrideBams

  async function submitOverride() {
    const bam = overrideBams.find(b => b.id === overrideBamId)
    if (!bam) { notify('error', 'Pick a student first.'); return }
    if (!overridePeriod) { notify('error', 'Pick which month this receipt is for.'); return }
    if (!overrideFile) { notify('error', 'Choose the receipt image or PDF.'); return }
    if (overrideReasonText.trim().length < MIN_REASON_LENGTH) {
      notify('error', `Say why this should count, in at least ${MIN_REASON_LENGTH} characters -- it goes in the audit log.`)
      return
    }
    setOverrideBusy(true)
    try {
      const bytes = await overrideFile.arrayBuffer()
      const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
      const sha256 = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')

      const form = new FormData()
      form.append('file', overrideFile)
      form.append('bam_id', bam.id)
      form.append('sha256', sha256)
      form.append('period', overridePeriod)
      if (bam.cohortId) form.append('cohort_id', bam.cohortId)
      form.append('override_reason', overrideReasonText.trim())

      const res = await fetch('/api/portal/upload', { method: 'POST', body: form })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.ok) {
        notify('error', json?.message || `Upload failed (${res.status})`)
        return
      }
      notify('ok', `Uploaded for ${bam.name}. It will go through OCR like any other receipt.`)
      setOverrideOpen(false)
      setOverrideBamId('')
      setOverrideSearch('')
      setOverridePeriod('')
      setOverrideReasonText('')
      setOverrideFile(null)
      loadAll()
    } finally {
      setOverrideBusy(false)
    }
  }

  const loadAll = () => {
    fetch('/api/admin/data?table=receipts')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setAllRows((data as DbReceipt[]).map(mapDbReceipt))
          setUseDb(true)
        } else {
          setAllRows([])
        }
      })
      .catch(() => setAllRows([]))
  }

  useEffect(() => { loadAll() }, [])

  /* Poll while any receipt is pending OCR.
   *
   * Watches allRows, not the filtered queue. OCR keeps running whatever is on screen,
   * and polling the visible list would mean picking a cohort quietly stops waiting for
   * a receipt still being read in another one. */
  useEffect(() => {
    if (!allRows.some(r => r.status === 'pending')) return
    const timer = setInterval(loadAll, 5000)
    return () => clearInterval(timer)
  }, [allRows])

  const { cohortFilter, hideTest, setFilters, cohortOptions, matches } = useCohortFilter()
  const visible = allRows.filter(r => matches({ cohortId: r.cohortId, isTest: r.isTest }))
  const queue   = visible.filter(r => r.status === 'pending' || r.status === 'review' || r.status === 'ocr_failed')
  // Newest decision first. It used to follow the upload date, so a receipt uploaded on the 2nd and
  // rejected today sat 18 rows down and looked as if the rejection had not been recorded.
  const history = visible
    .filter(r => r.status === 'approved' || r.status === 'rejected' || r.status === 'auto_pass')
    .sort((a, b) => b.sortMs - a.sortMs)

  const pendingCount   = queue.filter(r => r.status === 'pending').length
  const reviewCount    = queue.filter(r => r.status === 'review').length
  const ocrFailedCount = queue.filter(r => r.status === 'ocr_failed').length
  const approvedCount  = history.filter(r => r.status === 'approved' || r.status === 'auto_pass').length
  const rejectedCount  = history.filter(r => r.status === 'rejected').length

  function toggleOpen(i: number) {
    setOpenIdx(openIdx === i ? null : i)
    setConfirming(null)
    setReason('')
    // Never let a corrected amount or a corrected tick typed for one receipt survive
    // into another.
    setAmountOverride('')
    setBlSelection(null)
  }

  function decide(action: 'approve' | 'reject') {
    setConfirming(action)
    setReason(action === 'approve' ? 'Meets Bud Light reimbursement criteria' : 'Not a Bud Light purchase')
    // The corrected ticks and the corrected amount are both set BEFORE this point
    // now, so neither is cleared here.
  }

  /** Which lines are ticked right now: the pending edit if there is one, else the record. */
  function selectedLines(r: Row): number[] {
    if (blSelection && blSelection.id === r.id) return blSelection.indices
    return currentBudLightIndices(r.ocrJson)
  }

  function toggleLine(r: Row, index: number) {
    const current = selectedLines(r)
    const next = current.includes(index)
      ? current.filter(i => i !== index)
      : [...current, index].sort((a, b) => a - b)
    setBlSelection({ id: r.id, indices: next })
  }

  function resetLines(r: Row) {
    setBlSelection({ id: r.id, indices: currentBudLightIndices(r.ocrJson) })
  }

  /**
   * The preview. `applyBudLightCorrection` is the server's own function, so
   * `recomputed.total` here is what the server will store, but it is still labelled a
   * preview: the server recomputes from its own copy of ocr_json and that answer wins.
   */
  function correctionFor(r: Row) {
    if (!r.ocrJson || !Array.isArray(r.ocrJson.lines) || r.ocrJson.lines.length === 0) return null
    return applyBudLightCorrection(r.ocrJson, selectedLines(r))
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
        notify('error', 'Corrected amount must be a non-negative number')
        return
      }
      overrideTotal = Math.round(parsed * 100) / 100
    }

    /*
     * Corrected classification. Sent only when a tick actually moved, and only on an
     * approve (a rejection records that the receipt is not reimbursable at all, so
     * there is no classification to save). The indices are all that is sent: the
     * server loads its own ocr_json, applies them and re-derives the amount, so a
     * client total is never trusted.
     */
    let budLightLines: number[] | undefined
    if (action === 'approve') {
      const corr = correctionFor(row)
      if (corr && corr.changed.length > 0) {
        if (corr.indices.length === 0) {
          notify('error',
            'No line is ticked as Bud Light, so there is nothing to reimburse. Reject the receipt instead, ' +
            'or reset the ticks and use the corrected amount if the line items are unreadable.')
          return
        }
        budLightLines = corr.indices
      }
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
          ...(overrideTotal !== undefined ? { override_total: overrideTotal } : {}),
          ...(budLightLines !== undefined ? { bud_light_lines: budLightLines } : {})
        })
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) {
        notify('error', json.message || json.error || 'Decision failed')
        return
      }
      const decided: Row = {
        ...row,
        status: action === 'approve' ? 'approved' : 'rejected',
        sortMs: Date.now(),
        decidedAt: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        decidedReason: reason.trim() || (action === 'approve' ? 'Approved by admin' : 'Rejected by admin')
      }
      // By id, not by index: `i` came from the rendered list, and the rendered list
      // is a filtered view of allRows.
      setAllRows(rows => rows.map(x => (x.id === row.id ? decided : x)))
      setOpenIdx(null)
      setConfirming(null)
      setAmountOverride('')
      setBlSelection(null)
      // Report what the server said it recorded. The old text asserted
      // "Reimbursement confirmed" unconditionally, including on the path where
      // decide skips the ledger entirely (a receipt with no amount), so Robin was
      // told a reimbursement existed when none had been written.
      if (action === 'reject') {
        // A rejection that could not reach the student is a failure, not a success:
        // they are the one who needs to know.
        if (json.bam_notified === false) notify('error', 'Rejected, but the email to the BAM did not send.')
        else notify('ok', 'Rejected. BAM will be notified')
      } else if (typeof json.ledger_paid_cad === 'number') {
        // Report what the SERVER says it stored, including the amount it recomputed
        // from the corrected ticks, so the preview is never the thing that is trusted.
        const parts: string[] = []
        if (json.classification_changed) {
          const added = Array.isArray(json.lines_added) ? json.lines_added.length : 0
          const removed = Array.isArray(json.lines_removed) ? json.lines_removed.length : 0
          parts.push(`Bud Light lines corrected (${added} added, ${removed} removed)`)
        }
        if (typeof json.stored_total === 'number') {
          parts.push(`receipt total recorded as $${json.stored_total.toFixed(2)}`
            + (json.amount_source === 'override_total' && json.classification_changed
              ? ' from the corrected amount you typed'
              : json.amount_source === 'corrected_lines' ? ' recomputed from the corrected lines' : ''))
        } else if (json.override_applied) {
          parts.push('amount corrected')
        }
        notify('ok', `Approved. Reimbursement recorded: $${json.ledger_paid_cad.toFixed(2)}`
          + (parts.length ? `. ${parts.join('. ')}.` : ''))
      } else {
        notify('error', 'Approved, but NO reimbursement was recorded for this receipt. Check the amount.')
      }
    } catch {
      notify('error', 'Network error: decision not saved')
    }
  }

  /**
   * Reopen a decided receipt. This used to only mutate local state, so it looked
   * like it worked and silently reverted on refresh. It now calls the server,
   * which also recomputes the reimbursement ledger.
   */
  async function revertToReview(row: Row) {
    const reason = window.prompt(
      `Reopen ${row.bam}'s receipt for another decision?\n\n` +
      `Why are you reopening it? Saved to the audit log. ` +
      `At least ${MIN_REASON_LENGTH} characters, for example "typo".`
    )
    if (reason === null) return
    // Same function the server uses, so what is shown here matches what the server
    // would have said, instead of a vaguer local guess.
    const issue = reasonProblem(reason, 'Reason for reopening')
    if (issue) {
      notify('error', `Reopen cancelled. ${issue}`)
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
        notify('error', `Reopen failed: ${j.message ?? j.error ?? res.status}`)
        return
      }

      setAllRows(rows => rows.map(x => (
        x.id === row.id ? { ...x, status: 'review' as const, decidedAt: undefined, decidedReason: undefined } : x
      )))
      // A reopen that could not recompute the ledger needs attention, not a tick.
      if (j.warning) notify('error', `${row.bam} reopened, but ${j.warning}`)
      else notify('ok', `${row.bam} reopened for review. Reimbursement now $${Number(j.ledger_paid_cad ?? 0).toFixed(2)}`)
    } catch (e) {
      notify('error', `Reopen failed: ${(e as Error).message}`)
    }
  }

  const activeList = tab === 'queue' ? queue : history

  return (
    <>
      <TopBar crumbs={['Receipts', tab === 'queue' ? 'Review queue' : 'History']} />

      {/* Onboarding forms whose email did not match the roster. Not receipts, whatever the old
          name said. Shown only when one is waiting; see QueueLink hideWhenNone. */}
      <QueueLink
        href="/admin/unmatched"
        title="Onboarding forms"
        countKey="unmatched"
        labelSome={n => `${n} ${n === 1 ? 'was' : 'were'} submitted with an email that is not on the roster`}
        labelNone="none right now"
        hideWhenNone
      />

      <div className={`surface receipt-override ${overrideOpen ? 'is-open' : ''}`}>
        <div className="surface-header">
          <div style={{ fontWeight: 600, fontSize: 14 }}>Upload for a student</div>
          <button className="btn-ghost" aria-expanded={overrideOpen} onClick={() => setOverrideOpen(o => !o)}>
            {overrideOpen ? 'Close' : 'Missed deadline'}
          </button>
        </div>
        {overrideOpen && (
          <div className="receipt-override-form" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              For a closed month only, and only with a reason -- it goes in the audit log.
              A future month, or a month outside that student&rsquo;s program, is still refused.
            </p>
            <label style={{ fontSize: 12, fontWeight: 600 }}>
              Student
              <input
                className="input"
                style={{ display: 'block', width: '100%', marginTop: 4 }}
                placeholder="Type a name…"
                value={overrideBamId ? overrideBams.find(b => b.id === overrideBamId)?.name ?? '' : overrideSearch}
                onChange={e => { setOverrideBamId(''); setOverrideSearch(e.target.value) }}
              />
              {overrideSearch && !overrideBamId && (
                <div className="surface" style={{ marginTop: 4, maxHeight: 160, overflowY: 'auto' }}>
                  {overrideMatches.length === 0 && <div style={{ padding: 8, fontSize: 12 }} className="muted">No match</div>}
                  {overrideMatches.slice(0, 20).map(b => (
                    <button
                      key={b.id}
                      type="button"
                      className="btn-ghost"
                      style={{ display: 'block', width: '100%', textAlign: 'left', fontSize: 13, padding: '6px 10px' }}
                      onClick={() => { setOverrideBamId(b.id); setOverrideSearch('') }}
                    >
                      {b.name}{b.isTest ? ' (test account)' : ''}
                    </button>
                  ))}
                </div>
              )}
            </label>
            <label style={{ fontSize: 12, fontWeight: 600 }}>
              Month the receipt is for
              <input
                type="month"
                className="input"
                style={{ display: 'block', width: '100%', marginTop: 4 }}
                value={overridePeriod}
                onChange={e => setOverridePeriod(e.target.value)}
              />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600 }}>
              Receipt image or PDF
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                style={{ display: 'block', width: '100%', marginTop: 4 }}
                onChange={e => setOverrideFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600 }}>
              Why this should still count
              <textarea
                className="input"
                style={{ display: 'block', width: '100%', marginTop: 4, minHeight: 60 }}
                value={overrideReasonText}
                onChange={e => setOverrideReasonText(e.target.value)}
                placeholder="e.g. the upload page showed the wrong month after the deadline, see support ticket from Elle Edwards"
              />
            </label>
            <button
              className="btn-navy"
              disabled={overrideBusy}
              style={{ alignSelf: 'flex-start' }}
              onClick={submitOverride}
            >
              {overrideBusy ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        )}
      </div>

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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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

        {/* Same control as /admin/roster and /admin/invoices, sharing one stored choice,
            so picking a cohort on one screen does not leave another showing TEST rows.
            The tab counts and the badges above are all computed from the filtered list. */}
        <CohortFilterBar
          className="receipt-filterbar"
          cohortLabel="Cohort"
          mode="menu"
          cohortFilter={cohortFilter}
          hideTest={hideTest}
          setFilters={setFilters}
          cohortOptions={cohortOptions}
        />

        {/* Fixed toast. This was a badge hardcoded to badge-green, so failures read as successes. */}
        <Toast notice={notice} onDismiss={() => setNotice(null)} />
        {/* Contained to this box, not the page -- see app/admin/unmatched/page.tsx for the fault
            this fixes: an unwrapped admin-table drags the whole page (sidebar included)
            sideways on a phone. */}
        <div className="table-scroll">
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
            {activeList.map((r, i) => {
              /*
               * The BL? ticks are the correction surface for a receipt still in the
               * queue: APPROVE / REJECT alone could not fix a mis-tagged line, only
               * the number it produced. History rows are read-only.
               */
              const editable = tab === 'queue'
              const selected = selectedLines(r)
              // Only the expanded row needs a recompute; the queue can hold 58 rows.
              const correction = editable && openIdx === i ? correctionFor(r) : null
              const touched = (correction?.changed.length ?? 0) > 0
              return (
              <Fragment key={r.id}>
                <tr>
                  <td style={{ padding: '4px 6px' }}>
                    {r.storageKey && isPdfReceipt(r.storageMime) ? (
                      <div
                        onClick={() => setLightbox({ src: receiptImageUrl(r.storageKey!, r.bam), pdf: true })}
                        title="PDF receipt"
                        style={{
                          width: 40, height: 40, borderRadius: 6,
                          border: '1px solid var(--stone)', background: 'var(--bl-fog)',
                          display: 'grid', placeItems: 'center', cursor: 'pointer',
                          fontSize: 9, fontWeight: 700, color: 'var(--midgray)', letterSpacing: 0.5,
                        }}
                      >
                        PDF
                      </div>
                    ) : r.storageKey ? (
                      <img
                        src={receiptImageUrl(r.storageKey, r.bam)}
                        alt="Receipt"
                        onClick={() => setLightbox({ src: receiptImageUrl(r.storageKey!, r.bam), pdf: false })}
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
                  <td className="muted" style={{ fontSize: 12.5, maxWidth: 360 }}><ReasonList reason={r.reason} storageBytes={r.storageBytes} compact /></td>
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
                        {r.storageKey && isPdfReceipt(r.storageMime) ? (
                          <div style={{ flexShrink: 0 }}>
                            <object
                              data={receiptImageUrl(r.storageKey, r.bam)}
                              type="application/pdf"
                              style={{
                                width: 160, height: 220, display: 'block',
                                borderRadius: 8, border: '1px solid var(--stone)',
                                background: 'var(--stone-lt)'
                              }}
                            >
                              {/* Shown by browsers that will not embed a PDF at all. */}
                              <a href={receiptImageUrl(r.storageKey, r.bam)} target="_blank" rel="noreferrer">
                                Open PDF
                              </a>
                            </object>
                            <button
                              onClick={() => setLightbox({ src: receiptImageUrl(r.storageKey!, r.bam), pdf: true })}
                              style={{
                                marginTop: 6, width: 160, padding: '4px 0', fontSize: 11,
                                border: '1px solid var(--stone)', borderRadius: 6,
                                background: '#fff', cursor: 'pointer', color: 'var(--midgray)'
                              }}
                            >
                              Open full size
                            </button>
                          </div>
                        ) : r.storageKey ? (
                          <div
                            onClick={() => setLightbox({ src: receiptImageUrl(r.storageKey!, r.bam), pdf: false })}
                            style={{ flexShrink: 0, cursor: 'pointer' }}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={receiptImageUrl(r.storageKey, r.bam)}
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
                          <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}><ReasonList reason={r.reason} storageBytes={r.storageBytes} /></div>

                          {r.ocrJson && r.ocrJson.lines && (
                            <div style={{ marginBottom: 12 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--midgray)', marginBottom: 4 }}>
                                OCR Result {r.ocrJson.store && `| ${r.ocrJson.store}`} {r.ocrJson.date && `(${r.ocrJson.date})`}
                              </div>
                              {editable && (
                                <div style={{ fontSize: 11.5, color: 'var(--midgray)', marginBottom: 6, lineHeight: 1.5 }}>
                                  Click a line to include or exclude it from the Bud Light total. Ticked lines are counted.
                                </div>
                              )}
                              <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%', maxWidth: 460 }}>
                                <thead>
                                  <tr style={{ borderBottom: '1px solid var(--stone)' }}>
                                    <th style={{ textAlign: 'left', padding: '3px 8px 3px 0', fontSize: 10, color: 'var(--midgray)' }}>Item</th>
                                    <th style={{ textAlign: 'right', padding: '3px 8px', fontSize: 10, color: 'var(--midgray)' }}>Total</th>
                                    <th style={{ textAlign: 'center', padding: '3px 8px', fontSize: 10, color: 'var(--midgray)' }}>BL?</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.ocrJson.lines.map((l, li) => {
                                    const on = editable ? selected.includes(li) : l.is_bud_light
                                    const moved = editable && on !== l.is_bud_light
                                    return (
                                      <tr
                                        key={li}
                                        onClick={editable ? () => toggleLine(r, li) : undefined}
                                        title={editable ? (on ? 'Counted as Bud Light. Click to exclude.' : 'Not counted. Click to include.') : undefined}
                                        style={{
                                          borderBottom: '1px solid var(--bl-fog)',
                                          background: on ? 'var(--green-bg, #e6f4ea)' : 'transparent',
                                          cursor: editable ? 'pointer' : 'default',
                                          outline: moved ? '2px solid var(--bl-blue)' : 'none'
                                        }}
                                      >
                                        <td style={{ padding: '3px 8px 3px 0' }}>
                                          {l.desc}
                                          {l.ambiguous && <span style={{ color: 'var(--amber)', marginLeft: 4, fontSize: 10 }}>?</span>}
                                          {moved && (
                                            <span style={{ color: 'var(--bl-blue-ink)', marginLeft: 6, fontSize: 10, fontWeight: 600 }}>
                                              {on ? 'added by you' : 'removed by you'}
                                            </span>
                                          )}
                                        </td>
                                        <td style={{ textAlign: 'right', padding: '3px 8px', fontVariantNumeric: 'tabular-nums' }}>{formatLineTotal(l.total)}</td>
                                        <td style={{ textAlign: 'center', padding: '3px 8px' }}>
                                          {editable ? (
                                            <button
                                              type="button"
                                              onClick={e => { e.stopPropagation(); toggleLine(r, li) }}
                                              aria-pressed={on}
                                              aria-label={`${on ? 'Exclude' : 'Include'} ${l.desc}`}
                                              style={{
                                                background: on ? 'var(--green)' : 'transparent',
                                                color: on ? '#fff' : 'var(--midgray)',
                                                border: `1px solid ${on ? 'var(--green)' : 'var(--stone)'}`,
                                                borderRadius: 4, width: 26, height: 20, padding: 0,
                                                fontSize: 12, fontWeight: 700, lineHeight: 1, cursor: 'pointer'
                                              }}
                                            >
                                              {on ? '✓' : ''}
                                            </button>
                                          ) : on ? (
                                            <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓</span>
                                          ) : (
                                            <span style={{ color: 'var(--midgray)' }}>—</span>
                                          )}
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                              <div style={{ fontSize: 11, marginTop: 6, color: 'var(--midgray)' }}>
                                BL total the AI read: <strong style={{ color: 'var(--text)' }}>${(r.ocrJson.bud_light_total_incl_tax ?? 0).toFixed(2)}</strong>
                                {' '} · Grand total: ${(r.ocrJson.grand_total ?? 0).toFixed(2)}
                                {' '} · Confidence: {((r.ocrJson.overall_confidence ?? 0) * 100).toFixed(0)}%
                              </div>

                              {/*
                                Live preview of the correction. The figure comes from the SAME
                                function the route uses (applyBudLightCorrection, which re-runs
                                recomputeBudLightTotal), but it is labelled a preview because the
                                server recomputes from its own copy of ocr_json and that answer is
                                the one stored and reported back after approval.
                              */}
                              {editable && correction && (
                                <div
                                  style={{
                                    marginTop: 10, padding: '10px 12px', borderRadius: 8, maxWidth: 460,
                                    border: `1px solid ${touched ? 'var(--bl-blue)' : 'var(--stone)'}`,
                                    background: touched ? 'rgba(0,112,206,0.06)' : 'var(--stone-lt)'
                                  }}
                                >
                                  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12 }}>
                                    <div>
                                      <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--midgray)' }}>On record now</div>
                                      <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                                        {r.totalCad != null ? `$${r.totalCad.toFixed(2)}` : 'no amount'}
                                      </div>
                                    </div>
                                    <div>
                                      <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--midgray)' }}>Preview, server recomputes</div>
                                      <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: touched ? 'var(--bl-blue)' : 'var(--text)' }}>
                                        ${correction.recomputed.total.toFixed(2)}
                                      </div>
                                    </div>
                                    {touched && r.totalCad != null && (
                                      <div>
                                        <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--midgray)' }}>Change</div>
                                        <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: correction.recomputed.total >= r.totalCad ? 'var(--green)' : 'var(--red)' }}>
                                          {correction.recomputed.total >= r.totalCad ? '+' : '-'}${Math.abs(correction.recomputed.total - r.totalCad).toFixed(2)}
                                        </div>
                                      </div>
                                    )}
                                    <div style={{ marginLeft: 'auto', alignSelf: 'center' }}>
                                      <button
                                        type="button"
                                        className="btn-ghost"
                                        style={{ fontSize: 11.5, padding: '4px 10px' }}
                                        disabled={!touched}
                                        onClick={() => resetLines(r)}
                                      >
                                        {r.ocrJson.admin_classification ? 'Reset to the saved ticks' : 'Reset to what the AI read'}
                                      </button>
                                    </div>
                                  </div>

                                  <div style={{ fontSize: 11.5, marginTop: 8, color: 'var(--midgray)', lineHeight: 1.55 }}>
                                    {correction.indices.length} of {r.ocrJson.lines.length} lines counted
                                    {touched ? `, ${correction.added.length} added and ${correction.removed.length} removed` : ''}.
                                    {' '}
                                    {(correction.recomputed.basis === 'lines_mixed_pretax' || correction.recomputed.basis === 'lines_raw') && (
                                      <span style={{ color: '#8a5a00' }}>
                                        This receipt does not let the Bud Light tax be worked out on its own, so the
                                        preview is the pre-tax sum. If the paper shows a tax-inclusive Bud Light total,
                                        type it into the corrected amount below and that figure is what will be paid.
                                      </span>
                                    )}
                                    {correction.recomputed.basis === 'lines_grossed_up' && 'Every counted line is Bud Light, so this receipt\u2019s own tax rate was applied.'}
                                    {correction.recomputed.basis === 'lines_incl_tax' && 'The line totals on this receipt already include tax.'}
                                    {correction.recomputed.basis === 'lines_mixed_rate_validated' && 'The tax-inclusive figure on this receipt matches a standard Canadian rate, so it was accepted.'}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {/*
                            The corrected amount used to appear only after clicking APPROVE, so it
                            was invisible while reviewing and easy to miss. It is the FALLBACK, for
                            when the line items cannot be used (OCR failed, no line detail, or the
                            tax cannot be derived from the receipt). The ticks above are the primary
                            tool because they fix the classification as well as the number.
                          */}
                          {editable && (
                            <div className="card" style={{ maxWidth: 460, marginBottom: 12, padding: 12 }}>
                              <div className="field" style={{ marginBottom: 0 }}>
                                <label style={{ fontSize: 12 }}>Corrected amount, optional fallback (CAD)</label>
                                <input
                                  value={amountOverride}
                                  onChange={e => setAmountOverride(e.target.value.replace(/[^\d.]/g, ''))}
                                  inputMode="decimal"
                                  placeholder={r.total === '—' ? 'e.g. 113.00' : r.total.replace('$', '')}
                                />
                                <div className="muted" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.55 }}>
                                  Use this when the line items themselves are unusable, or when the tax-inclusive
                                  Bud Light total can only be read off the paper. Leave it blank to reimburse
                                  {' '}
                                  {correction
                                    ? `$${correction.recomputed.total.toFixed(2)}`
                                    : r.total === '—' ? 'nothing (no amount was read)' : r.total}.
                                  {' '}Corrections are written to the audit log.
                                </div>
                                {amountOverride.trim() !== '' && touched && (
                                  <div style={{ fontSize: 11.5, marginTop: 6, color: '#7A0E0E', background: '#FDECEC', border: '1px solid rgba(163,18,18,0.3)', borderRadius: 6, padding: '6px 8px', lineHeight: 1.5 }}>
                                    Both are set. The ticks are saved as the corrected classification, and
                                    ${amountOverride.trim()} is the amount that gets paid, not the
                                    ${correction ? correction.recomputed.total.toFixed(2) : '0.00'} preview.
                                    Clear this field to pay the recomputed figure.
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          {/* History tab: show decision details + revert */}
                          {tab === 'history' && (
                            <div style={{ marginBottom: 14 }}>
                              {/*
                                Three statuses land in History, not two. This read
                                `status === 'approved' ? 'Approved' : 'Rejected'`, so an
                                auto_pass receipt was labelled "Rejected" in red directly
                                under a green AUTO PASS badge. Harmless while nothing
                                auto-passed; visible and alarming as soon as it did.
                              */}
                              <div style={{ fontSize: 12, marginBottom: 2 }}>
                                <span style={{
                                  fontWeight: 600,
                                  color: r.status === 'rejected' ? 'var(--red)' : 'var(--green)'
                                }}>
                                  {r.status === 'approved' ? 'Approved'
                                    : r.status === 'auto_pass' ? 'Auto-approved'
                                    : 'Rejected'}
                                </span>
                                {r.decidedAt
                                  ? <span className="muted"> · {r.decidedAt}</span>
                                  : r.status === 'auto_pass'
                                    ? <span className="muted"> · no admin decision needed</span>
                                    : null}
                              </div>
                              {r.decidedReason && (
                                <div className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>
                                  &ldquo;{r.decidedReason}&rdquo;
                                </div>
                              )}
                              <button
                                className="btn-ghost"
                                style={{ marginTop: 10, fontSize: 12, color: 'var(--bl-blue-ink)', borderColor: 'var(--bl-blue)' }}
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
                                style={{ background: 'var(--red)', color: '#fff' }}
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
                                      notify('ok', json.message || 'OCR retry queued')
                                    } catch {
                                      notify('error', 'Retry failed. Check server logs')
                                    }
                                    setRetrying(null)
                                  }}
                                >
                                  {retrying === r.id ? 'Retrying…' : 'Retry OCR'}
                                </button>
                              )}
                            </div>
                          )}

                          {tab === 'queue' && confirming === 'approve' && (
                            <div className="card" style={{ maxWidth: 460, marginTop: 8 }}>
                              <div style={{ marginBottom: 10, fontSize: 13 }}>
                                Confirm approve reimbursement for <strong>{r.bam}</strong>?
                              </div>

                              {/*
                                What will be recorded, spelled out. The corrected amount field and
                                the Bud Light ticks are both above this card now, so this is a
                                summary of the choices already made rather than a second place to
                                make them.
                              */}
                              <div style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.6 }}>
                                {amountOverride.trim() !== '' ? (
                                  <>
                                    Amount: <strong>${amountOverride.trim()}</strong>{' '}
                                    <span className="muted">(the corrected amount you typed)</span>
                                  </>
                                ) : correction ? (
                                  <>
                                    Amount: <strong>${correction.recomputed.total.toFixed(2)}</strong>{' '}
                                    <span className="muted">
                                      ({touched ? 'recomputed from the corrected Bud Light lines' : 'unchanged'})
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    Amount: <strong>{r.total}</strong> <span className="muted">(unchanged)</span>
                                  </>
                                )}
                                {touched && correction && (
                                  <div style={{ color: 'var(--bl-blue-ink)' }}>
                                    Bud Light lines corrected: {correction.added.length} added,{' '}
                                    {correction.removed.length} removed. Saved on the record.
                                  </div>
                                )}
                                <div className="muted" style={{ fontSize: 11.5 }}>
                                  The server recomputes the amount from the corrected lines, so the figure it
                                  records is reported back here after approval.
                                </div>
                              </div>

                              <div className="field">
                                <label>Reason</label>
                                <input value={reason} onChange={e => setReason(e.target.value)} />
                              </div>

                              <div style={{ display: 'flex', gap: 8 }}>
                                <button style={{ background: 'var(--green)' }} onClick={() => confirmDecision(i, 'approve')}>
                                  {amountOverride.trim()
                                    ? `Approve at $${amountOverride.trim()}`
                                    : touched && correction
                                      ? `Approve at $${correction.recomputed.total.toFixed(2)}`
                                      : 'Confirm approve'}
                                </button>
                                <button className="btn-ghost" onClick={() => setConfirming(null)}>Cancel</button>
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
                                <button style={{ background: 'var(--red)', color: '#fff' }} onClick={() => confirmDecision(i, 'reject')}>Confirm reject</button>
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
              )
            })}
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
      </div>

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.8)', display: 'grid', placeItems: 'center',
            cursor: 'zoom-out', padding: 24,
          }}
        >
          {lightbox.pdf ? (
            <iframe
              src={lightbox.src}
              title="Receipt full size"
              onClick={e => e.stopPropagation()}
              style={{
                width: '90vw', height: '90vh', border: 'none',
                borderRadius: 12, boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
                background: '#fff', cursor: 'default',
              }}
            />
          ) : (
            <img
              src={lightbox.src}
              alt="Receipt full size"
              onClick={e => e.stopPropagation()}
              style={{
                maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain',
                borderRadius: 12, boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
                cursor: 'default',
              }}
            />
          )}
          <button
            onClick={() => setLightbox(null)}
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
