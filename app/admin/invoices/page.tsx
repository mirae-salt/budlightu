'use client'

import { Fragment, useEffect, useState } from 'react'
import { isReimbursementLine } from '@/lib/receipt-badge'
import { sendEligibleAt, windowStartedAt } from '@/lib/business-days'
import { TopBar } from '../_components/TopBar'
import { Toast, type ToastNotice } from '../_components/Toast'
import { reasonProblem } from '@/lib/reason'
import { type InvoiceRow } from '../_lib/dummy'
import { useCohortFilter, CohortFilterBar } from '../_components/CohortFilter'
import { useTableSort, SortTh, compareText } from '../_components/SortHeader'

type PayloadLine = { qty: number; description: string; unitPrice: number; total: number }

type Row = InvoiceRow & {
  id: string
  cohort_id: string | null
  period: string
  /** Null until an admin publishes it to the BAM and starts their 24 hours (0035). */
  released_at: string | null
  revised_at: string | null
  /** Set when the BAM signed off, which clears it to send without waiting (0037). */
  accepted_at: string | null
  /** 'live' cohorts enforce the 24-hour wait; a rehearsing cohort does not. */
  sendMode: string | null
  /** Line items from payload_json. Banking is stripped server-side (redactPayload). */
  lines: PayloadLine[]
  /** The date printed on the invoice, YYYY-MM-DD. Empty when the payload has none. */
  invoiceDate: string
  subtotal?: number
  tax?: number
  /** Whether this invoice charges tax, and at what rate. Never the HST number. */
  taxApplicable: boolean
  /** PO number as stored on the invoice, so the preview shows what will be sent. */
  poNumber: string | null
  taxRate: number | null
  /**
   * Which of the BAM's details this invoice no longer matches on the roster, as field
   * names. The edit screens push corrections into open invoices when they save, but a
   * CSV import or a script does not, and a stale snapshot is invisible until it prints.
   * Banking is not in here: it is encrypted, and batch-approve already refuses to send
   * an invoice whose banking disagrees with the roster.
   */
  rosterDrift: string[]
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
  /**
   * When this invoice was published to its BAM, starting their 24-hour objection
   * window (0035). Null means batch-approve will refuse it: nobody has seen it yet.
   */
  released_at: string | null
  revised_at: string | null
  accepted_at: string | null
  /** The cohort's send mode. A non-live cohort waives the 24-hour wait, not the rest. */
  cohorts?: { send_mode?: string | null } | Array<{ send_mode?: string | null }> | null
  cohort_id: string
  payload_json: { total?: number; subtotal?: number; tax?: number; lines?: PayloadLine[]; jobNumber?: string; invoiceDate?: string } | null
  bams: { first_name: string; last_name: string } | null
  receipt_status: string | null
  receipt_total: number | null
  receipt_spent: number | null
  receipt_count: number
  tax_applicable?: boolean
  tax_rate?: number | null
  /** Field names this invoice no longer agrees with the roster on. Empty is the good case. */
  roster_drift?: string[]
}

function periodLabel(period: string): string {
  const d = new Date(period)
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/*
 * The badge has four states and they are not receipt states, because a BAM can have
 * several receipts in different states at once. summarizeReceipts on the server collapses
 * them; this only checks that what arrived is one of the four.
 *
 * It used to translate raw receipt statuses here, which is how the vocabulary drifted:
 * the server started sending 'ok' and this still expected 'auto_pass', so every good
 * invoice fell through to the muted dash. Both sides are strings, so the type checker saw
 * nothing. One vocabulary now, defined in lib/receipt-badge.ts.
 */
function mapReceiptStatus(s: string | null): InvoiceRow['receiptStatus'] {
  if (s === 'ok' || s === 'pending' || s === 'rejected' || s === 'none') return s
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
    released_at: inv.released_at ?? null,
    revised_at: inv.revised_at ?? null,
    accepted_at: inv.accepted_at ?? null,
    sendMode: (Array.isArray(inv.cohorts) ? inv.cohorts[0] : inv.cohorts)?.send_mode ?? null,
    cohort_id: inv.cohort_id,
    receiptStatus: mapReceiptStatus(inv.receipt_status),
    receiptTotal: inv.receipt_total != null ? `$${Number(inv.receipt_total).toFixed(2)}` : undefined,
    receiptSpent: inv.receipt_spent != null ? Number(inv.receipt_spent) : null,
    receiptCount: Number(inv.receipt_count ?? 0),
    lines: Array.isArray(inv.payload_json?.lines) ? inv.payload_json!.lines! : [],
    invoiceDate: typeof inv.payload_json?.invoiceDate === 'string' ? inv.payload_json.invoiceDate.slice(0, 10) : '',
    subtotal: inv.payload_json?.subtotal,
    tax: inv.payload_json?.tax,
    taxApplicable: inv.tax_applicable === true,
    poNumber: inv.payload_json?.jobNumber ?? null,
    taxRate: inv.tax_rate ?? null,
    rosterDrift: Array.isArray(inv.roster_drift) ? inv.roster_drift : []
  }
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
  const [releasing, setReleasing] = useState(false)
  /** Which invoice the "undo the confirmation" prompt is open on. */
  const [unconfirming, setUnconfirming] = useState<string | null>(null)
  const [unconfirmReason, setUnconfirmReason] = useState('')
  const [unconfirmBusy, setUnconfirmBusy] = useState(false)

  /*
   * Take back a BAM's confirmation. The realistic case is a student pressing it before
   * reading anything; until this existed the only way back was editing the database.
   */
  async function unconfirm(id: string) {
    setUnconfirmBusy(true)
    try {
      const res = await fetch('/api/admin/invoices/unconfirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: id, reason: unconfirmReason })
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) {
        reportBatch('error', j.message || `Could not undo that (${res.status})`)
        return
      }
      reportBatch('ok', j.warning
        ? `Confirmation undone. ${j.warning}`
        : 'Confirmation undone. It waits out its window again.')
      setUnconfirming(null)
      setUnconfirmReason('')
      loadInvoices()
    } finally {
      setUnconfirmBusy(false)
    }
  }
  /**
   * An invoice id from ?invoice=, set by the "Open the invoice" button on a question
   * thread. Read from window.location in an effect rather than with useSearchParams,
   * which would force this page into a Suspense boundary for a value only used after
   * mount -- the same reasoning as /admin/questions and its ?q=.
   */
  const [focusInvoice, setFocusInvoice] = useState<string | null>(null)

  useEffect(() => {
    setFocusInvoice(new URLSearchParams(window.location.search).get('invoice'))
  }, [])

  // Scroll once the rows exist, not on mount: firing early scrolls to nothing while the
  // list is still loading.
  useEffect(() => {
    if (!focusInvoice || allInvoices.length === 0) return
    document.getElementById(`inv-${focusInvoice}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusInvoice, allInvoices.length])
  /*
   * Open objections. They live at the top of this page rather than behind a tab because
   * each one is holding a payment: batch-approve refuses any invoice with an unresolved
   * row, so an objection nobody notices is an invoice that silently never sends.
   */
  const [disputes, setDisputes] = useState<Array<{
    id: string
    invoice_id: string | null
    question: string
    submitted_at: string
    bams: { first_name: string; last_name: string } | null
  }>>([])

  /*
   * Open objections are unanswered question threads that point at an invoice (0035).
   * Answering happens on /admin/questions, which already threads the conversation and
   * emails the BAM the reply, so this screen lists them and links there rather than
   * growing a second reply box that would notify nobody.
   */
  function loadDisputes() {
    return fetch('/api/admin/data?table=questions')
      .then(res => res.json())
      .then(({ data }) => {
        const rows = (data ?? []) as Array<{
          id: string; invoice_id: string | null; answered_at: string | null
          question: string; submitted_at: string
          bams: { first_name: string; last_name: string } | null
        }>
        setDisputes(rows.filter(q => q.invoice_id && !q.answered_at))
      })
      .catch(() => {})
  }
  const [batchNotice, setBatchNotice] = useState<Notice | null>(null)
  const [previewNumber, setPreviewNumber] = useState<string | null>(null)
  const [syncingId, setSyncingId] = useState<string | null>(null)
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
  const [editDate, setEditDate] = useState('')
  const [savingLines, setSavingLines] = useState(false)

  const { sort, toggleSort } = useTableSort<'bam' | 'period' | 'amount' | 'status'>()

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

  /*
   * Students owed an invoice that does not exist. The table below lists invoices, so a
   * student with none was invisible: Lea Major (2026-09) had an approved reimbursement
   * and no row anywhere on this screen.
   */
  type MissingRow = {
    kind: 'missing' | 'held'
    id: string; name: string; status: string; cohort: string; period: string; month: string
    receipts: number
    /** kind 'missing' */
    missing_address?: string[]; has_bank?: boolean
    /** kind 'held' */
    invoice_number?: string; reasons?: string[]
  }
  const [missingRows, setMissingRows] = useState<MissingRow[]>([])
  const [creatingKey, setCreatingKey] = useState<string | null>(null)
  function loadMissing() {
    return fetch('/api/admin/invoices/missing')
      .then(res => res.json())
      .then(j => { if (j.ok) setMissingRows(j.rows as MissingRow[]) })
      .catch(() => {})
  }
  async function createMissing(row: MissingRow) {
    setCreatingKey(`${row.id}|${row.period}`)
    try {
      const res = await fetch('/api/admin/invoices/missing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, period: row.period })
      })
      const j = await res.json()
      const extra = [
        j.hold,
        Array.isArray(j.missing_confirmations) && j.missing_confirmations.length
          ? `Not yet given by the student: ${j.missing_confirmations.join(', ')}.` : '',
        j.warning
      ].filter(Boolean).join(' ')
      reportBatch(res.ok && j.ok ? 'ok' : 'error', `${row.name}: ${j.message || res.statusText}${extra ? ` ${extra}` : ''}`)
      await Promise.all([loadMissing(), loadInvoices()])
    } catch (e) {
      reportBatch('error', `${row.name}: could not create the invoice (${(e as Error).message})`)
    } finally {
      setCreatingKey(null)
    }
  }

  // Named so releasing can re-read the list afterwards: `released_at` decides what the
  // buttons offer, and a stale row would keep offering a release that already happened.
  function loadInvoices() {
    return fetch('/api/admin/data?table=invoices')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setAllInvoices((data as DbInvoice[]).map(mapDbInvoice))
          setUseDb(true)
        }
      })
      .catch(() => {})
  }

  useEffect(() => {
    loadInvoices()
    loadMissing()
    loadDisputes()

    // Who "me" is, for the test send.
    fetch('/api/admin/team')
      .then(res => res.json())
      .then(j => { if (typeof j?.me?.email === 'string') setTestSendAddress(j.me.email) })
      .catch(() => {})
  }, [])

  const { cohortFilter, hideTest, setFilters, cohortOptions, matches } = useCohortFilter()
  const inCohort = allInvoices.filter(inv => matches({ cohortId: inv.cohort_id ?? null }))

  /*
   * MONTH. Defaults to the current month, because by October the list still carried every
   * September invoice and the one that mattered was buried in it. It is not remembered
   * between visits on purpose: a month chosen last week must not hide this one.
   *
   * Hiding rows by default is how Lea Major's unsent September invoice could vanish, so an
   * earlier month that still has something unsent shows an amber count on its own button
   * (`unsentByMonth`). That count is what makes the default safe.
   */
  const [monthFilter, setMonthFilter] = useState<string>('current')
  const thisMonth = new Date().toISOString().slice(0, 7)
  const shownMonth = monthFilter === 'current' ? thisMonth : monthFilter.slice(0, 7)
  const invoices = monthFilter === 'all' ? inCohort : inCohort.filter(inv => inv.period.slice(0, 7) === shownMonth)
  /**
   * Real (live-cohort) invoices from an EARLIER month than this one that nobody has sent, by
   * month. Shown as a badge on that month's button, so a default that hides old months still
   * says when one of them has something unsent. The current month is not counted: its drafts
   * wait for the 17th by design, and a warning that is always on stops being read.
   */
  const unsentByMonth = inCohort
    .filter(i => i.sendMode === 'live' && (i.status === 'draft' || i.status === 'approved') && i.period.slice(0, 7) < thisMonth)
    .reduce<Record<string, number>>((acc, i) => { const m = i.period.slice(0, 7); acc[m] = (acc[m] ?? 0) + 1; return acc }, {})
  const unsentMonths = Object.keys(unsentByMonth).sort((a, b) => b.localeCompare(a))
  const unsentTotal = Object.values(unsentByMonth).reduce((sum, count) => sum + count, 0)
  const activeMonthId = monthFilter === 'all' ? 'all' : shownMonth
  const activeMonthLabel = activeMonthId === 'all'
    ? 'All months'
    : new Date(`${activeMonthId}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  function moveMonth(offset: number) {
    const base = monthFilter === 'all' ? thisMonth : shownMonth
    const [year, month] = base.split('-').map(Number)
    const next = new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7)
    setMonthFilter(next === thisMonth ? 'current' : next)
    setSelected(new Set())
  }

  // Display order only. `invoices` (unsorted) is what selection, totals and the
  // draft/approved splits below are computed from, so re-sorting the table never
  // changes which rows are selected or what a batch action does.
  const sortedInvoices = sort ? [...invoices].sort((a, b) => {
    const { key, dir } = sort
    if (key === 'amount') {
      const av = parseFloat(a.amount.replace(/[$,]/g, '')) || 0
      const bv = parseFloat(b.amount.replace(/[$,]/g, '')) || 0
      return (av - bv) * dir
    }
    return compareText(a[key], b[key], dir)
  }) : invoices

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

  /*
   * Releasing publishes a finished invoice to its BAM and starts the 24 hours Legal
   * asked for. Only an unreleased draft can be released, and re-releasing is refused by
   * the server rather than silently restarting somebody's clock.
   */
  const releasableSelected = selectedDrafts.filter(inv => !inv.released_at)

  /*
   * What the AP button will actually send, split from what it will refuse.
   *
   * The count on a button has to be the truth about what pressing it does. Before the
   * objection window these were the same number, so "Approve selected (12)" sent 12.
   * Now batch-approve refuses an invoice that is unreleased, inside its 24 hours, or
   * carrying an open objection, and a button still promising 12 would report a screen
   * of blocked rows and teach Robin to ignore the result.
   *
   * Recomputed here from the same three rules the server enforces. When they disagree
   * the server wins: it refuses, and the toast names each one.
   */
  const disputedInvoiceIds = new Set(disputes.map(d => d.invoice_id))
  const sendableSelected = selectedDrafts.filter(inv => {
    /*
     * Each rule gets its own line and returns, rather than being &&-ed into one
     * expression after the fact.
     *
     * It was written as `start && ... && waitOver`, with waitOver computed on the line
     * above as `sendEligibleAt(start!)`. The `!` silenced the type checker and the call
     * still ran when start was null, so `null.getTime()` threw and took the whole page
     * down the moment anyone selected an unreleased draft in a live cohort -- which is
     * all 55 of September's. Ordering an expression is not the same as guarding a call.
     */
    const start = windowStartedAt(inv.released_at)
    if (!start) return false
    if (disputedInvoiceIds.has(inv.id)) return false
    // Mirrors the server: a cohort that is not live waives the wait, so the count on the
    // button matches what pressing it will actually send.
    return inv.sendMode !== 'live' || Date.now() >= sendEligibleAt(start).getTime()
  })
  const heldSelected = selectedDrafts.filter(inv => !sendableSelected.includes(inv))

  async function releaseSelected() {
    if (releasableSelected.length === 0) return
    setReleasing(true)
    try {
      const res = await fetch('/api/admin/invoices/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_ids: releasableSelected.map(inv => inv.id) })
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) {
        reportBatch('error', json.message || `Release failed (${res.status})`)
        return
      }
      const blocked = (json.results ?? []).filter((r: { blocked?: string }) => r.blocked)
      if (blocked.length > 0) {
        // Named, not counted. "3 blocked" sends her to ask which three.
        reportBatch('error',
          `Released ${json.released}. Not released: ` +
          blocked.map((r: { invoice_number?: string; blocked?: string }) => `${r.invoice_number ?? '?'} (${r.blocked})`).join('; '))
      } else {
        // The dryrun case is said once, as part of the success, rather than as a problem
        // against each invoice: in a test cohort it is true every time and it worked.
        const dryrun = json.dryrun_no_email > 0
          ? ` This cohort is in dryrun, so the portal was updated and no email was sent.`
          : ''
        reportBatch('ok',
          `Released ${json.released} to their BAMs. They can be sent to AP after ${new Date(json.window_closes).toLocaleString()}.${dryrun}`)
      }
      loadInvoices()
    } catch (e) {
      reportBatch('error', `Release failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReleasing(false)
    }
  }

  async function confirmBatchApprove() {
    setBatchConfirming(false)
    // Only what the button counted. Posting the whole selection would make the server
    // refuse the held ones and report failures for rows this screen already said were
    // not going, which reads as a broken send rather than a working gate.
    if (!useDb || sendableSelected.length === 0) {
      reportBatch('ok', `${sendableSelected.length} invoices approved. AP emails queued (dryrun mode). BAM copies queued.`)
      return
    }
    try {
      const res = await fetch('/api/admin/invoices/batch-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_ids: sendableSelected.map(inv => inv.id) })
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) {
        /*
         * SAY WHY, NOT HOW MANY.
         *
         * This used to read "Batch approve failed (39 of 39 failed)" and nothing else, while
         * the response carried a sentence per invoice explaining exactly what held it. Janet
         * hit that on 2026-09-18, retried it for three days, and the reason was only found by
         * querying production by hand. A refusal nobody can act on is the same as no refusal.
         *
         * Grouped by reason rather than listed per invoice: 39 copies of one sentence is a
         * wall, and the thing worth knowing is that all 39 share one cause.
         */
        const held = (json.results ?? []).filter((r: { blocked?: string }) => r.blocked)
        if (held.length > 0) {
          const byReason = new Map<string, string[]>()
          for (const r of held as Array<{ invoice_number?: string; blocked: string }>) {
            const list = byReason.get(r.blocked) ?? []
            list.push(r.invoice_number ?? '?')
            byReason.set(r.blocked, list)
          }
          const lines = [...byReason.entries()].map(([reason, nums]) =>
            `${nums.length} held: ${reason} (${nums.slice(0, 5).join(', ')}${nums.length > 5 ? `, +${nums.length - 5} more` : ''})`
          )
          const checked = json.processed ?? held.length
          reportBatch('error', `${checked} checked, ${checked - held.length} sent. ${lines.join('. ')}`)
        } else {
          reportBatch('error', json.message || `Batch approve failed (${json.failures ?? '?'} of ${json.processed ?? '?'} failed)`)
        }
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
    setEditDate(inv.invoiceDate)
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
          // Sent only when it changed, so an edit to the lines never re-stamps the date.
          ...(editDate && editDate !== inv.invoiceDate ? { invoice_date: editDate } : {}),
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
          invoiceDate: typeof json.invoice_date === 'string' ? json.invoice_date.slice(0, 10) : i.invoiceDate,
          subtotal: json.subtotal,
          tax: json.tax,
          amount: `$${Number(json.total).toFixed(2)}`
        } : i))
        setEditingId(null)
        const warnings: string[] = Array.isArray(json.warnings) ? json.warnings : []
        const saved =
          `${json.invoice_number}: saved. Server total ${money(Number(json.total))}.` +
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

  /**
   * Pull this invoice's snapshot back into line with the roster.
   *
   * The edit screens already push a correction into open invoices when they save. This is
   * the repair for everything that does not go through them -- an import, a script, a hand
   * edit -- and for confirming that an invoice IS current, which nothing could answer
   * before. It clears the archived PDF too, so the next render is a real render rather
   * than the bytes stored before the correction.
   */
  async function syncRoster(inv: Row) {
    setSyncingId(inv.id)
    try {
      const res = await fetch('/api/admin/invoices/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: inv.id })
      })
      const json = await res.json()
      // `ok: false` here means an open invoice could not be brought up to date, which is
      // the state that quietly sends a wrong document. It does not get a green badge.
      reportRow(res.ok && json.ok ? 'ok' : 'error', `${inv.number}: ${json.message ?? res.statusText}`)
      loadInvoices()
    } catch (e) {
      reportRow('error', `Sync failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSyncingId(null)
    }
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

      {disputes.length > 0 && (
        <div className="surface" style={{ marginBottom: 16, borderLeft: '3px solid var(--amber, #d97706)' }}>
          <div className="surface-header">
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {disputes.length} BAM{disputes.length > 1 ? 's' : ''} raised a question about their invoice
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              Each one holds its invoice until you answer it
            </span>
          </div>
          <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {disputes.map(d => (
              <div key={d.id} style={{ borderTop: '1px solid var(--bl-silver)', paddingTop: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {d.bams ? `${d.bams.first_name} ${d.bams.last_name}` : 'Unknown BAM'}
                  <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontFamily: 'monospace' }}>
                    {/* The invoice number is already the first thing the BAM's own message
                        says ("Invoice INV-EE1: ..."), so this resolves it from the table on
                        screen rather than joining for a field we are about to print twice. */}
                    {allInvoices.find(i => i.id === d.invoice_id)?.number ?? d.invoice_id}
                  </span>
                  <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 11 }}>
                    {new Date(d.submitted_at).toLocaleString()}
                  </span>
                </div>
                <p style={{ fontSize: 13, margin: '6px 0 8px', lineHeight: 1.6 }}>{d.question}</p>
                <a
                  href={`/admin/questions?q=${d.id}`}
                  className="btn-ghost"
                  style={{ fontSize: 12, textDecoration: 'none', display: 'inline-block', padding: '5px 12px' }}
                >
                  Open the thread and answer
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {missingRows.length > 0 && (
        <details className="surface" style={{ marginBottom: 16 }}>
          {/* Collapsed by default: it is a to-do list, not the work of the page. The count
              in the title is what has to stay visible. */}
          <summary className="surface-header" style={{ cursor: 'pointer', listStyle: 'revert' }}>
            <span className="surface-title">Can&apos;t be sent yet ({missingRows.length})</span>
            <span className="muted" style={{ fontSize: 12 }}>
              No invoice, or a draft that is held. Creating one makes a draft only.
            </span>
          </summary>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>BAM</th><th>Month</th><th>Receipts</th><th>Why not sent</th><th></th></tr>
              </thead>
              <tbody>
                {missingRows.map(r => {
                  const key = `${r.id}|${r.period}`
                  const gaps = r.kind === 'held'
                    ? (r.reasons ?? [])
                    : ['no invoice',
                       r.status === 'pending' ? 'onboarding not finished' : '',
                       r.missing_address?.length ? 'no mailing address' : '',
                       r.has_bank ? '' : 'no banking'
                      ].filter(Boolean)
                  return (
                    <tr key={key}>
                      <td>{r.name} <span className="muted" style={{ fontSize: 11 }}>{r.cohort}</span></td>
                      <td className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{r.month}</td>
                      <td style={{ fontSize: 13 }}>{r.receipts}</td>
                      <td style={{ fontSize: 12 }}>{gaps.length ? gaps.join(', ') : <span className="muted">nothing</span>}</td>
                      <td style={{ textAlign: 'right' }}>
                        {r.kind === 'held' ? (
                          <a href="/admin/roster" className="btn-ghost" style={{ fontSize: 12, whiteSpace: 'nowrap', textDecoration: 'none' }}>
                            {r.invoice_number}: fill in on Roster
                          </a>
                        ) : (
                        <button
                          className="btn-ghost"
                          style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                          disabled={creatingKey !== null}
                          onClick={() => createMissing(r)}
                        >
                          {creatingKey === key ? 'Creating…' : `Create ${r.month} draft`}
                        </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="surface">
        <div className="invoice-cycle" aria-label={`Invoice cycle for ${currentMonth}`}>
          <div className="invoice-cycle-month">
            <span>Invoice cycle</span>
            <strong>{currentMonth}</strong>
          </div>
          <div className={`invoice-cycle-milestone ${day < deadlineDay ? 'is-upcoming' : 'is-passed'}`}>
            <span className="invoice-cycle-index">01</span>
            <div className="invoice-cycle-detail">
              <span>Receipt deadline</span>
              <strong>{deadlineDay}<small>th</small></strong>
              <span className="invoice-cycle-state">
                {day < deadlineDay ? `${daysLeft} days left` : 'Deadline passed'}
              </span>
            </div>
          </div>
          <div className={`invoice-cycle-milestone ${day > generateDay ? 'is-ready' : ''}`}>
            <span className="invoice-cycle-index">02</span>
            <div className="invoice-cycle-detail">
              <span>Invoice generation</span>
              <strong>{generateDay}<small>th</small></strong>
              <span className="invoice-cycle-state">
                {day < generateDay ? 'Auto-generate' : day === generateDay ? 'Today' : 'Review drafts'}
              </span>
            </div>
          </div>
        </div>

        <div className="invoice-toolbar-heading">
          <div className="invoice-toolbar-summary">
            <div className="surface-title">Batch approval</div>
            <div className="invoice-toolbar-stats">
              <span><strong>{invoices.length}</strong> invoices</span>
              <span className="invoice-stats-divider" aria-hidden="true" />
              <span><strong>${total.toFixed(2)}</strong> total</span>
            </div>
            {approvedUnsent.length > 0 && (
              <span className="badge badge-yellow invoice-unsent-badge">
                {approvedUnsent.length} approved, not sent to AP
              </span>
            )}
          </div>
          <div className="invoice-export-actions" role="group" aria-label="Export invoices">
            <button className="btn-ghost" onClick={downloadCsv} disabled={invoices.length === 0}>CSV</button>
            <button className="btn-ghost" onClick={downloadZip} disabled={invoices.length === 0 || zipLoading}>
              {zipLoading ? 'Preparing ZIP…' : 'ZIP'}
            </button>
          </div>
        </div>

        {selectedDrafts.length > 0 && (
          <div className="invoice-batch-actions">
            <span className="invoice-selection-count">
              <strong>{selectedDrafts.length}</strong> draft{selectedDrafts.length === 1 ? '' : 's'} selected
            </span>
            <div className="invoice-batch-buttons">
            {/*
              TWO ACTIONS, NUMBERED, AND ONLY ONE OF THEM SPENDS MONEY.
              ---------------------------------------------------------
              These used to be one button called "Approve selected", which both approved
              AND emailed accounts payable. The name described the internal half and said
              nothing about the half that cannot be undone. Now the step number carries
              the order, the label names the recipient, and the weight matches the stakes:
              releasing is reversible in practice (nothing has left the building), sending
              is not (Mirae, 2026-09-16).
            */}
            <button
              className="btn-ghost"
              onClick={releaseSelected}
              disabled={releasableSelected.length === 0 || releasing}
              title="Step 1. Publishes these to the BAMs and starts their 24 hours to raise anything wrong. Nothing leaves Salt."
            >
              {releasing ? 'Releasing…' : `Step 1 · Release (${releasableSelected.length})`}
            </button>
            <button
              onClick={() => setBatchConfirming(true)}
              disabled={sendableSelected.length === 0}
              title="Step 2. Emails accounts payable. This cannot be undone."
            >
              2 · Send to AP ({sendableSelected.length})
            </button>
            </div>
          </div>
        )}

        {/*
          Why the two counts differ. Without this the second button just looks broken:
          twelve rows ticked, "Send (0)", and no way to find out which rule is holding
          them. Says the rule and the number, not a generic "some are not ready".
        */}
        {heldSelected.length > 0 && (
          <div className="muted" style={{ fontSize: 12, padding: '0 16px 10px', lineHeight: 1.6 }}>
            {heldSelected.length} of the {selectedDrafts.length} selected cannot go to AP yet:
            {' '}{heldSelected.filter(i => !i.released_at).length} not released to the BAM,
            {' '}{heldSelected.filter(i => i.released_at && disputedInvoiceIds.has(i.id)).length} with a question open,
            {' '}{heldSelected.filter(i => i.released_at && !disputedInvoiceIds.has(i.id)).length} still inside the BAM&rsquo;s 24 hours
            {' '}(a BAM who confirms clears theirs straight away).
          </div>
        )}

        {/* Sits above the batch controls, not below the table: the count and total in
            the header line describe the filtered view, and Approve acts on it. */}
        <CohortFilterBar
          className="invoice-filterbar"
          cohortLabel="Cohort"
          mode="menu"
          cohortFilter={cohortFilter}
          hideTest={hideTest}
          setFilters={next => { setFilters(next); setSelected(new Set()) }}
          cohortOptions={cohortOptions}
          showTestToggle={false}
          trailing={(
            <div className="filterbar-group invoice-month-group" role="group" aria-label="Invoice month">
              <span className="filterbar-label">Month</span>
              <button className="invoice-month-arrow" aria-label="Previous month" title="Previous month" onClick={() => moveMonth(-1)}>‹</button>
              <span className="invoice-month-current" aria-live="polite">{activeMonthLabel}</span>
              <button className="invoice-month-arrow" aria-label="Next month" title="Next month" onClick={() => moveMonth(1)}>›</button>
              {activeMonthId !== thisMonth && (
                <button className="invoice-month-quick" onClick={() => { setMonthFilter('current'); setSelected(new Set()) }}>
                  This month
                </button>
              )}
              <button
                className={`invoice-month-quick ${monthFilter === 'all' ? 'is-active' : ''}`}
                aria-pressed={monthFilter === 'all'}
                onClick={() => { setMonthFilter(monthFilter === 'all' ? 'current' : 'all'); setSelected(new Set()) }}
              >
                All months
              </button>
              {unsentTotal > 0 && (
                <button
                  className="invoice-overdue-shortcut"
                  onClick={() => { setMonthFilter(unsentMonths[0]); setSelected(new Set()) }}
                >
                  Review {unsentTotal} unsent
                </button>
              )}
            </div>
          )}
        />

        {unconfirming && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 10, fontSize: 13, lineHeight: 1.6 }}>
              Undo the confirmation on{' '}
              <strong>{allInvoices.find(i => i.id === unconfirming)?.number ?? 'this invoice'}</strong>?
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                It goes back to waiting out its window, and the BAM can confirm it again.
                Nothing else about the invoice changes.
              </div>
            </div>
            <input
              className="input"
              style={{ display: 'block', width: '100%', maxWidth: 480, marginBottom: 8 }}
              value={unconfirmReason}
              onChange={e => setUnconfirmReason(e.target.value)}
              placeholder="Why, e.g. she pressed it by accident and asked us to undo it"
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={unconfirmBusy} onClick={() => unconfirm(unconfirming)}>
                {unconfirmBusy ? 'Undoing…' : 'Undo confirmation'}
              </button>
              <button className="btn-ghost" disabled={unconfirmBusy} onClick={() => setUnconfirming(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {batchConfirming && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 10, fontSize: 13, lineHeight: 1.6 }}>
              Email accounts payable <strong>{sendableSelected.length}</strong> invoice
              {sendableSelected.length === 1 ? '' : 's'}, one message each, and send each BAM their copy?
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {/* Said here rather than only in the button title: this is the last screen
                    before the mail goes, and "cannot be undone" belongs where the decision is. */}
                Sent mail cannot be recalled. Every one of these has been with its BAM for at
                least 24 hours with nothing raised.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmBatchApprove}>Send to accounts payable</button>
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
        {/* one-line: "September 2026" was wrapping in the period column and making
            every row two lines tall. The four full-width cells below carry panels
            and prose, so each opts back out with `wrap`. */}
        <table className="admin-table one-line">
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
              <SortTh sortKey="bam" sort={sort} onSort={toggleSort}>BAM</SortTh>
              <SortTh sortKey="period" sort={sort} onSort={toggleSort}>Period</SortTh>
              <SortTh sortKey="amount" sort={sort} onSort={toggleSort} align="right">Amount</SortTh>
              <th>Receipt</th>
              <SortTh sortKey="status" sort={sort} onSort={toggleSort}>Status</SortTh>
              <th style={{ textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {sortedInvoices.map(inv => {
              const receiptOk = inv.receiptStatus === 'ok'
              const receiptPending = inv.receiptStatus === 'pending'
              const receiptBad = inv.receiptStatus === 'rejected'

              return (
              <Fragment key={inv.id}>
                <tr id={`inv-${inv.id}`} style={{
                  // The row somebody was sent here to look at. Without it the link lands on
                  // a page of 58 and leaves them to find it by invoice number.
                  background: focusInvoice === inv.id ? 'var(--bl-fog)' : undefined,
                  borderLeft:
                  inv.status === 'void' ? '3px solid var(--red, #ef4444)'
                  : inv.status === 'sent' || inv.status === 'paid' ? '3px solid var(--green, #22c55e)'
                  : inv.status === 'approved' ? '3px solid var(--bl-blue, #0073cf)'
                  : receiptPending ? '3px solid var(--amber, #f59e0b)'
                  : '3px solid transparent'
                }}>
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
                    <div className="cell-trunc" style={{ fontWeight: 600, fontSize: 13, '--trunc': '19ch' } as React.CSSProperties} title={inv.bam}>{inv.bam}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--midgray)' }}>{inv.number}</div>
                  </td>
                  <td className="muted" style={{ fontSize: 13 }}>{periodLabel(inv.period)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: 14 }}>{inv.amount}</td>
                  <td>
                    {receiptOk
                      ? <span
                          className="badge badge-green"
                          style={{ fontSize: 10 }}
                          /* Spend and payment differ once a BAM goes over the monthly cap.
                             The badge shows what the invoice pays, so it matches the total
                             beside it, and the tooltip carries the rest. */
                          title={
                            inv.receiptSpent != null && (inv.receiptCount ?? 0) > 0
                              ? `${inv.receiptCount} receipt${inv.receiptCount === 1 ? '' : 's'}, $${inv.receiptSpent.toFixed(2)} spent`
                              : undefined
                          }
                        >{inv.receiptTotal}</span>
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
                      : inv.released_at && inv.accepted_at
                      /*
                        Signed off by the BAM, so it is no longer waiting on them and no
                        longer waiting on the clock: this one can go now. It read "WITH BAM"
                        after they had confirmed, which is the same thing the student's own
                        badge got wrong, and it is the row Robin most wants to pick out.
                      */
                      ? <span
                          className="badge badge-green"
                          title={`The BAM confirmed this at ${new Date(inv.accepted_at).toLocaleString()}. It can go to AP now.`}
                        >
                          CONFIRMED
                        </span>
                      : inv.released_at
                      /*
                        A released draft is the state Robin acts on next, and the one she
                        cannot act on yet, so the badge says which. Without it every draft
                        looks alike and "Approve selected" silently blocks half of them.

                        A corrected one says so separately (0036): its clock restarted, and
                        "WITH BAM" alone would look like the same invoice from yesterday
                        that is nearly ready to go.
                      */
                      ? <span
                          className="badge badge-blue"
                          title={
                            inv.revised_at && new Date(inv.revised_at) > new Date(inv.released_at)
                              ? `Corrected at ${new Date(inv.revised_at).toLocaleString()} after it was published, so the BAM's 24 hours restarted from then.`
                              : `Published to the BAM at ${new Date(inv.released_at).toLocaleString()}. Can go to AP once their 24 hours are up.`
                          }
                        >
                          {inv.revised_at && new Date(inv.revised_at) > new Date(inv.released_at)
                            ? 'WITH BAM · CORRECTED'
                            : 'WITH BAM'}
                        </span>
                      : <span className="badge badge-yellow" title="Not shown to the BAM yet. Release it before approving.">DRAFT</span>}
                    {/* The invoice is a snapshot of the roster taken when it was created.
                        Everything that edits a BAM from a screen pushes the correction back
                        into it, but an import or a script does not, and nobody can see a
                        stale snapshot until it prints. So the difference is shown rather
                        than waited for. */}
                    {inv.rosterDrift.length > 0 && (
                      <span
                        className="badge badge-red"
                        style={{ marginLeft: 6, fontSize: 10 }}
                        title={`This invoice still shows the old ${inv.rosterDrift.join(', ')}. The roster has been changed since it was created. Press Sync to bring it up to date.`}
                      >
                        OUT OF DATE
                      </span>
                    )}
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
                            style={{
                              padding: '3px 8px',
                              fontSize: 11,
                              ...(inv.rosterDrift.length > 0 ? { color: 'var(--bl-red, #b91c1c)', fontWeight: 600 } : {})
                            }}
                            disabled={!useDb || syncingId === inv.id}
                            onClick={() => syncRoster(inv)}
                            title={inv.rosterDrift.length > 0
                              ? `Pull the current name, address and banking off the roster. This invoice still shows the old ${inv.rosterDrift.join(', ')}.`
                              : 'Pull the current name, address and banking off the roster. Nothing here looks out of date, so this should report no change.'}
                          >
                            {syncingId === inv.id ? 'Syncing…' : 'Sync'}
                          </button>
                        )}
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
                              : 'Edit the salary line, ad-hoc items and the invoice date. The reimbursement line is changed on the receipt.'}
                          >
                            {editingId === inv.id ? 'Close edit' : 'Edit'}
                          </button>
                        )}
                        {/* TEST AP IS ONLY ON REHEARSING COHORTS.
                            It sat on every draft row, which in September is 55 of them, and
                            the whole AP path has been exercised four times in five weeks --
                            invoice_sends holds four rows across two invoices. A rehearsal is
                            something you do once for a cohort, not once per invoice, and a
                            button that sends mail does not belong beside the ones Robin
                            presses daily.

                            The gate is send_mode rather than the cohort's name, because what
                            makes a test send sensible is that mail does not actually leave.

                            RETRY AP IS NOT THE SAME BUTTON and is left alone: on an approved
                            invoice it is the only way to finish a send that got as far as
                            'approved' and no further. It shows on approved rows only, which
                            is a handful. */}
                        {(inv.status === 'approved' || (inv.status === 'draft' && inv.sendMode !== 'live')) && (
                          <button
                            className="btn-ghost"
                            style={{ padding: '3px 8px', fontSize: 11 }}
                            onClick={() => openApPreview(inv)}
                            title={inv.status === 'approved'
                              ? 'Approved but not marked sent. Retry the AP send.'
                              : 'Test send only, and only because this cohort is rehearsing. Run batch approval before this invoice can go to AP.'}
                          >
                            {inv.status === 'approved' ? 'Retry AP' : 'Test AP'}
                          </button>
                        )}
                        {/* Only where there is something to undo. A student who pressed
                            confirm by accident has no way back on their own side, and this
                            was a hand-edit of the database until now. */}
                        {inv.accepted_at && inv.status === 'draft' && (
                          <button
                            className="btn-ghost"
                            style={{ padding: '3px 8px', fontSize: 11 }}
                            onClick={() => { setUnconfirming(inv.id); setUnconfirmReason('') }}
                            title={`The BAM confirmed this at ${new Date(inv.accepted_at).toLocaleString()}. Undo it and the invoice waits out its window again.`}
                          >
                            Undo confirm
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
                    <td colSpan={7} className="wrap" style={{ background: 'var(--bl-silver)', padding: 16 }}>
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
                    <td colSpan={7} className="wrap" style={{ background: 'var(--bl-silver)', padding: 16 }}>
                      <div className="card" style={{ maxWidth: 760 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--bl-navy)', marginBottom: 4 }}>
                          Edit · {inv.number} ({inv.bam})
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

                        {(() => {
                          const first = `${inv.period.slice(0, 7)}-01`
                          const last = new Date(Date.UTC(Number(inv.period.slice(0, 4)), Number(inv.period.slice(5, 7)), 0)).toISOString().slice(0, 10)
                          const today = new Date().toISOString().slice(0, 10)
                          const max = last < today ? last : today
                          const outside = editDate !== '' && (editDate < first || editDate > max)
                          return (
                            <div className="field">
                              <label>Invoice date</label>
                              <input
                                type="date"
                                value={editDate}
                                min={first}
                                max={max}
                                onChange={e => setEditDate(e.target.value)}
                                style={{ maxWidth: 200 }}
                              />
                              <span className="muted" style={{ fontSize: 11 }}>
                                Normally the 16th. It has to be in {periodLabel(inv.period)} and cannot be in the future.
                                A date you choose stays if the invoice is rebuilt.
                              </span>
                              {outside && (
                                <span className="muted" style={{ fontSize: 11, color: 'var(--amber)' }}>
                                  That date is outside {periodLabel(inv.period)}.
                                </span>
                              )}
                            </div>
                          )
                        })()}

                        <div className="field">
                          <label>Why is this changing?</label>
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
                            disabled={savingLines || !reasonOk || emptyDesc || badNumber
                              || (editDate !== '' && (editDate < `${inv.period.slice(0, 7)}-01` || editDate.slice(0, 7) !== inv.period.slice(0, 7)))}
                          >
                            {savingLines ? 'Saving…' : 'Save'}
                          </button>
                          <button className="btn-ghost" onClick={() => setEditingId(null)} disabled={savingLines}>Cancel</button>
                          <span className="muted" style={{ fontSize: 11, lineHeight: 1.4 }}>
                            Saving clears the stored PDF so the next send re-renders it from these lines and this date.
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                  )
                })()}

                {voidingNumber === inv.number && (
                  <tr>
                    <td colSpan={7} className="wrap" style={{ background: 'var(--bl-silver)', padding: 16 }}>
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
                <td colSpan={7} className="wrap">
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
