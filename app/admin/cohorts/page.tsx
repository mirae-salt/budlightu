'use client'

/**
 * /admin/cohorts
 *
 * Three defects fixed here (2026-08-10):
 *
 * 1. Create always failed and reported success in green. The POST body never
 *    included `salary_default`, which the API requires before it touches the
 *    database (cohorts.salary_default is NOT NULL with no default). The 400 body
 *    carries `message`, not `error`, so the page fell into its "Saved locally
 *    (DB unavailable)" branch, rendered it in a hard-coded badge-green and
 *    appended a row that existed only in React state.
 *
 * 2. The badge was green regardless of outcome, on every action on the page.
 *    Notices now carry a kind and failures render red and stay put.
 *
 * 3. Every Settings input PATCHed on each keystroke, so typing a six-digit PO
 *    fired six requests of which five failed the ^\d{6}$ check. The text and date
 *    fields are now a draft with an explicit Save. The mode buttons still write
 *    immediately: one click, one request, a value that is always valid.
 *
 * Also: salary, reimbursement cap, rollover mode and first-cohort-all-review are
 * displayed read-only. All four decide money and none of them was visible
 * anywhere in the UI. rollover_mode and first_cohort_all_review are deliberately
 * NOT editable here (they are not in the PATCH allowlist): rollover is a
 * program-wide decision (flat $150/month, no carryover, Robin 2026-08-04) and a
 * stray click must not be able to change it.
 */

import { Fragment, useEffect, useState } from 'react'
import { TopBar } from '../_components/TopBar'
import { Toast } from '../_components/Toast'
import { COHORTS, BAMS, type CohortRow } from '../_lib/dummy'

type Row = CohortRow & {
  id: string | null
  bamCopyMode: 'off' | 'draft' | 'live'
  startDate: string
  endDate: string
  salaryDefault: number | null
  reimbursementMax: number | null
  rolloverMode: string | null
  firstCohortAllReview: boolean | null
}

type DbCohort = {
  id: string
  name: string
  program_label: string
  po_number: string | null
  start_date: string
  end_date: string
  send_mode: 'dryrun' | 'live'
  bam_copy_mode: 'off' | 'draft' | 'live'
  salary_default: number | string | null
  reimbursement_max: number | string | null
  rollover_mode: string | null
  first_cohort_all_review: boolean | null
}

/** Empty-cell glyph, unchanged from before and the same as every other admin
 *  table. It is a placeholder for a missing value, never punctuation in prose. */
const EMPTY_CELL = '—'

function monthsLabel(start: string, end: string): string {
  const s = new Date(start).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  const e = new Date(end).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  return `${s} to ${e}`
}

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function money(v: number | null): string {
  return v === null ? 'not set' : `$${v.toFixed(2)}`
}

function rowFromDb(c: DbCohort & { bam_count?: number }): Row {
  const ended = new Date(c.end_date) < new Date()
  return {
    id: c.id,
    name: c.name,
    label: c.program_label,
    po: c.po_number || EMPTY_CELL,
    months: c.start_date && c.end_date ? monthsLabel(c.start_date, c.end_date) : EMPTY_CELL,
    bams: c.bam_count ?? 0,
    sendMode: c.send_mode,
    bamCopyMode: c.bam_copy_mode,
    startDate: c.start_date || '',
    endDate: c.end_date || '',
    salaryDefault: toNumber(c.salary_default),
    reimbursementMax: toNumber(c.reimbursement_max),
    rolloverMode: c.rollover_mode ?? null,
    firstCohortAllReview: c.first_cohort_all_review ?? null,
    status: ended ? 'ended' : 'active'
  }
}

/** Salary confirmed with Robin: school year Sept to Apr, and summer BAMs. */
const SALARY_SCHOOL_YEAR = '218.75'
const SALARY_SUMMER = '250'

type NewCohortForm = {
  name: string
  label: string
  po: string
  start: string
  end: string
  salary: string
}

const EMPTY_FORM: NewCohortForm = {
  name: '', label: '', po: '', start: '', end: '', salary: SALARY_SCHOOL_YEAR
}

/** Editable-with-an-explicit-save subset of the Settings panel. */
type SettingsDraft = { name: string; label: string; po: string; startDate: string; endDate: string }

type Notice = { kind: 'ok' | 'error'; text: string }

type BamSummary = { id: string; name: string; status: string; email: string }

export default function Cohorts() {
  const [cohorts, setCohorts] = useState<Row[]>([])
  const [managingId, setManagingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<NewCohortForm>(EMPTY_FORM)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [bamsByCohort, setBamsByCohort] = useState<Record<string, BamSummary[]>>({})
  const [allBams, setAllBams] = useState<BamSummary[]>([])
  const [addingBam, setAddingBam] = useState(false)

  useEffect(() => {
    fetch('/api/admin/data?table=cohorts')
      .then(res => res.json())
      .then(({ data }) => {
        if (!data || data.length === 0) {
          setCohorts(COHORTS.map(c => ({
            ...c, id: null, bamCopyMode: 'draft' as const, startDate: '', endDate: '',
            salaryDefault: null, reimbursementMax: null, rolloverMode: null, firstCohortAllReview: null
          })))
          return
        }
        setCohorts((data as (DbCohort & { bam_count: number })[]).map(rowFromDb))
      })
      .catch(() => {
        setCohorts(COHORTS.map(c => ({
          ...c, id: null, bamCopyMode: 'draft' as const, startDate: '', endDate: '',
          salaryDefault: null, reimbursementMax: null, rolloverMode: null, firstCohortAllReview: null
        })))
      })

    fetch('/api/admin/data?table=bams')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          const grouped: Record<string, BamSummary[]> = {}
          for (const b of data as { id: string; first_name: string; last_name: string; email: string; status: string; cohort_id: string }[]) {
            const summary: BamSummary = { id: b.id, name: `${b.first_name || ''} ${b.last_name || ''}`.trim(), status: b.status, email: b.email }
            const cid = b.cohort_id
            if (!cid) continue
            if (!grouped[cid]) grouped[cid] = []
            grouped[cid].push(summary)
          }
          setAllBams(data.map((b: { id: string; first_name: string; last_name: string; email: string; status: string; cohort_id: string }) => ({
            id: b.id,
            name: `${b.first_name || ''} ${b.last_name || ''}`.trim(),
            status: b.status,
            email: b.email,
            cohortId: b.cohort_id || null
          })))
          setBamsByCohort(grouped)
        } else {
          const grouped: Record<string, BamSummary[]> = {}
          BAMS.forEach(b => {
            if (!grouped[b.cohort]) grouped[b.cohort] = []
            grouped[b.cohort].push({ id: '', name: b.name, status: b.status, email: b.email })
          })
          setBamsByCohort(grouped)
        }
      })
      .catch(() => {
        const grouped: Record<string, BamSummary[]> = {}
        BAMS.forEach(b => {
          if (!grouped[b.cohort]) grouped[b.cohort] = []
          grouped[b.cohort].push({ id: '', name: b.name, status: b.status, email: b.email })
        })
        setBamsByCohort(grouped)
      })
  }, [])

  /** Failures stay on screen until the next action; only successes fade. */
  function report(kind: 'ok' | 'error', text: string) {
    const n = { kind, text }
    setNotice(n)
    if (kind === 'ok') setTimeout(() => setNotice(cur => (cur === n ? null : cur)), 4000)
  }

  function toggleManage(key: string, row: Row) {
    const opening = managingId !== key
    setManagingId(opening ? key : null)
    setDraft(opening
      ? { name: row.name, label: row.label, po: row.po === EMPTY_CELL ? '' : row.po, startDate: row.startDate, endDate: row.endDate }
      : null)
    setCreating(false)
    setAddingBam(false)
  }

  async function removeBamFromCohort(cohortId: string | null, bamId: string) {
    if (!cohortId || !bamId) return
    try {
      const res = await fetch('/api/admin/cohorts/member', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bam_id: bamId })
      })
      const j = await res.json()
      if (!res.ok || j.ok === false) {
        report('error', `Not removed: ${j.message || j.error || res.statusText}`)
        return
      }
      setBamsByCohort(prev => {
        const updated = { ...prev }
        if (updated[cohortId]) updated[cohortId] = updated[cohortId].filter(b => b.id !== bamId)
        return updated
      })
      setAllBams(prev => prev.map(b => b.id === bamId ? { ...b, cohortId: null } as typeof b : b))
      setCohorts(list => list.map(c => c.id === cohortId ? { ...c, bams: Math.max(0, c.bams - 1) } : c))
      report(j.warning ? 'error' : 'ok', j.warning ? `Removed, but: ${j.warning}` : 'BAM removed from cohort')
    } catch (e) {
      report('error', `Not removed: ${(e as Error).message}`)
    }
  }

  async function addBamToCohort(cohortId: string, bamId: string) {
    try {
      const res = await fetch('/api/admin/cohorts/member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bam_id: bamId, cohort_id: cohortId })
      })
      const j = await res.json()
      if (!res.ok || j.ok === false) {
        report('error', `Not added: ${j.message || j.error || res.statusText}`)
        return
      }
      const bam = (allBams as (BamSummary & { cohortId?: string | null })[]).find(b => b.id === bamId)
      if (bam) {
        setBamsByCohort(prev => {
          const updated = { ...prev }
          if (!updated[cohortId]) updated[cohortId] = []
          updated[cohortId] = [...updated[cohortId], { id: bam.id, name: bam.name, status: bam.status, email: bam.email }]
          return updated
        })
        setAllBams(prev => prev.map(b => b.id === bamId ? { ...b, cohortId } as typeof b : b))
        setCohorts(list => list.map(c => c.id === cohortId ? { ...c, bams: c.bams + 1 } : c))
      }
      report(j.warning ? 'error' : 'ok', j.warning ? `Added, but: ${j.warning}` : 'BAM added to cohort')
      setAddingBam(false)
    } catch (e) {
      report('error', `Not added: ${(e as Error).message}`)
    }
  }

  /**
   * One PATCH, one outcome. `patch` is in API field names so nothing is guessed
   * on the way out, and the row is rebuilt from the response so the screen shows
   * what the database holds.
   */
  async function patchCohort(row: Row, patch: Record<string, unknown>, label: string) {
    if (!row.id) {
      report('error', 'This cohort is sample data with no database record, so it cannot be changed.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/admin/cohorts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, ...patch })
      })
      const j = await res.json()
      if (!res.ok || !j.ok || !j.data) {
        report('error', `${label} not saved: ${j.message || j.error || res.statusText}`)
        return
      }
      const saved = rowFromDb({ ...(j.data as DbCohort), bam_count: row.bams })
      setCohorts(list => list.map(c => c.id === row.id ? saved : c))
      if (managingId === row.id) {
        setDraft({
          name: saved.name, label: saved.label, po: saved.po === EMPTY_CELL ? '' : saved.po,
          startDate: saved.startDate, endDate: saved.endDate
        })
      }
      report('ok', `${label} saved`)
    } catch (e) {
      report('error', `${label} not saved: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  /** Explicit save for the text and date fields. Only what changed is sent. */
  async function saveSettings(row: Row) {
    if (!draft) return
    const patch: Record<string, unknown> = {}
    if (draft.name.trim() !== row.name) patch.name = draft.name.trim()
    if (draft.label.trim() !== row.label) patch.program_label = draft.label.trim()
    const currentPo = row.po === EMPTY_CELL ? '' : row.po
    if (draft.po.trim() !== currentPo) patch.po_number = draft.po.trim() || null
    if (draft.startDate !== row.startDate) patch.start_date = draft.startDate
    if (draft.endDate !== row.endDate) patch.end_date = draft.endDate

    if (Object.keys(patch).length === 0) {
      report('ok', 'Nothing changed')
      return
    }
    await patchCohort(row, patch, 'Settings')
  }

  async function addCohort() {
    if (!form.name.trim() || !form.start || !form.end) return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/cohorts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          program_label: form.label.trim() || form.name.trim(),
          po_number: form.po.trim() || null,
          start_date: form.start,
          end_date: form.end,
          // Required by the API and NOT NULL in the database. Leaving it out is
          // what made every create fail while the page showed green.
          salary_default: form.salary
        })
      })
      const j = await res.json()
      if (!res.ok || !j.ok || !j.data) {
        // No local-only row. A cohort that is not in the database cannot own an
        // invoice, and pretending otherwise is how a fake PO reaches a decision.
        report('error', `Cohort not created: ${j.message || j.error || res.statusText}`)
        return
      }
      setCohorts(list => [...list, rowFromDb({ ...(j.data as DbCohort), bam_count: 0 })])
      setForm(EMPTY_FORM)
      setCreating(false)
      report('ok', `Cohort ${(j.data as DbCohort).name} created`)
    } catch (e) {
      report('error', `Cohort not created: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  function getUnassignedBams(): (BamSummary & { cohortId?: string | null })[] {
    return (allBams as (BamSummary & { cohortId?: string | null })[]).filter(b => !b.cohortId)
  }

  const createDisabled = busy || !form.name.trim() || !form.start || !form.end || !form.salary.trim()

  return (
    <>
      <TopBar crumbs={['Roster', 'Cohorts']} />

      {/* Fixed toast: an inline badge beside the button was too easy to miss. */}
      <Toast notice={notice} onDismiss={() => setNotice(null)} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Program cohorts</div>
          <button onClick={() => { setCreating(c => !c); setManagingId(null); setDraft(null) }}>
            {creating ? 'Cancel' : '+ New cohort'}
          </button>
        </div>

        {creating && (
          <div className="card" style={{ marginBottom: 16, maxWidth: 520 }}>
            <div className="field">
              <label>Cohort name</label>
              <input placeholder="e.g. Winter 2027" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="field">
              <label>Program label</label>
              <input placeholder="e.g. BL Campus" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
            </div>
            <div className="field">
              <label>PO#</label>
              <input placeholder="e.g. 260351" value={form.po} onChange={e => setForm(f => ({ ...f, po: e.target.value }))} />
              <span className="muted" style={{ fontSize: 11, marginTop: 3, display: 'block' }}>
                Six digits. Can be left blank now and set before the first send.
              </span>
            </div>
            <div className="field">
              <label>Monthly salary per BAM</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  style={{ maxWidth: 140 }}
                  value={form.salary}
                  onChange={e => setForm(f => ({ ...f, salary: e.target.value }))}
                />
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12 }}
                  onClick={() => setForm(f => ({ ...f, salary: SALARY_SCHOOL_YEAR }))}
                >
                  School year
                </button>
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12 }}
                  onClick={() => setForm(f => ({ ...f, salary: SALARY_SUMMER }))}
                >
                  Summer
                </button>
              </div>
              <span className="muted" style={{ fontSize: 11, marginTop: 3, display: 'block' }}>
                ${SALARY_SCHOOL_YEAR} for the school year (Sept to Apr), ${SALARY_SUMMER} for summer BAMs.
                Reimbursement stays at $150 per month with no carryover.
              </span>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Start date</label>
                <input type="date" value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value }))} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>End date</label>
                <input type="date" value={form.end} onChange={e => setForm(f => ({ ...f, end: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={addCohort} disabled={createDisabled}>
                {busy ? 'Creating...' : 'Create cohort'}
              </button>
              <button className="btn-ghost" onClick={() => { setCreating(false); setForm(EMPTY_FORM) }}>Cancel</button>
            </div>
            {(!form.start || !form.end) && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                Start and end dates are required. They set the cohort&apos;s invoice months.
              </div>
            )}
          </div>
        )}

        <table className="admin-table">
          <thead>
            <tr>
              <th style={{ whiteSpace: 'nowrap' }}>Cohort</th>
              <th style={{ whiteSpace: 'nowrap' }}>Label</th>
              <th style={{ whiteSpace: 'nowrap' }}>PO#</th>
              <th style={{ whiteSpace: 'nowrap' }}>Months</th>
              <th style={{ whiteSpace: 'nowrap' }}>Salary</th>
              <th style={{ whiteSpace: 'nowrap' }}>BAMs</th>
              <th style={{ whiteSpace: 'nowrap' }}>Send</th>
              <th style={{ whiteSpace: 'nowrap' }}>Status</th>
              <th style={{ width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map(c => {
              const cKey = c.id || c.name
              const members = (c.id ? bamsByCohort[c.id] : bamsByCohort[c.name]) || []
              const activeCount = members.filter(m => m.status === 'active').length
              const pendingCount = members.filter(m => m.status === 'pending').length
              const unassigned = c.id ? getUnassignedBams() : []
              return (
                <Fragment key={cKey}>
                  <tr>
                    <td style={{ fontWeight: 600, color: 'var(--bl-navy)', whiteSpace: 'nowrap' }}>{c.name}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{c.label}</td>
                    <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{c.po}</td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{c.months}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{money(c.salaryDefault)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{c.bams || members.length}</td>
                    <td>
                      {c.sendMode === 'dryrun'
                        ? <span className="badge badge-yellow" style={{ whiteSpace: 'nowrap' }}>DRYRUN</span>
                        : <span className="badge badge-green" style={{ whiteSpace: 'nowrap' }}>LIVE</span>}
                    </td>
                    <td>
                      {c.status === 'active'
                        ? <span className="badge badge-blue" style={{ whiteSpace: 'nowrap' }}>ACTIVE</span>
                        : <span className="badge" style={{ background: 'var(--stone-lt)', color: 'var(--slate)', whiteSpace: 'nowrap' }}>ENDED</span>}
                    </td>
                    <td>
                      <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' }} onClick={() => toggleManage(cKey, c)}>
                        {managingId === cKey ? 'Close' : 'Manage'}
                      </button>
                    </td>
                  </tr>

                  {managingId === cKey && (
                    <tr>
                      <td colSpan={9} style={{ background: 'var(--bl-silver)', padding: 20 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 400px) 1fr', gap: 20 }}>
                          {/* Settings panel */}
                          <div className="card" style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: 'var(--bl-navy)' }}>Settings</div>

                            <div className="field">
                              <label>Cohort name</label>
                              <input
                                value={draft?.name ?? c.name}
                                onChange={e => setDraft(d => d ? { ...d, name: e.target.value } : d)}
                              />
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                              <div className="field">
                                <label>Program label</label>
                                <input
                                  value={draft?.label ?? c.label}
                                  onChange={e => setDraft(d => d ? { ...d, label: e.target.value } : d)}
                                />
                              </div>
                              <div className="field">
                                <label>PO#</label>
                                <input
                                  value={draft?.po ?? ''}
                                  placeholder="260351"
                                  onChange={e => setDraft(d => d ? { ...d, po: e.target.value } : d)}
                                />
                              </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                              <div className="field">
                                <label>Start</label>
                                <input
                                  type="date"
                                  value={draft?.startDate ?? c.startDate}
                                  onChange={e => setDraft(d => d ? { ...d, startDate: e.target.value } : d)}
                                />
                              </div>
                              <div className="field">
                                <label>End</label>
                                <input
                                  type="date"
                                  value={draft?.endDate ?? c.endDate}
                                  onChange={e => setDraft(d => d ? { ...d, endDate: e.target.value } : d)}
                                />
                              </div>
                            </div>

                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                              <button onClick={() => saveSettings(c)} disabled={busy}>
                                {busy ? 'Saving...' : 'Save settings'}
                              </button>
                              <button
                                className="btn-ghost"
                                onClick={() => setDraft({
                                  name: c.name, label: c.label, po: c.po === EMPTY_CELL ? '' : c.po,
                                  startDate: c.startDate, endDate: c.endDate
                                })}
                              >
                                Reset
                              </button>
                            </div>
                            <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 10 }}>
                              Nothing above is saved until you press Save settings.
                            </span>

                            {/*
                              These four decide what a BAM is paid, and they used to be
                              read-only here with a note saying Mirae changes them
                              elsewhere. On 2026-09-02 Class of 2027 was created holding
                              the wrong value for two of them, and the only way to correct
                              it was a script against production. The screen that shows a
                              value should be able to change it.

                              Each control saves on click and the row is rebuilt from what
                              the server returned, so the panel shows what is stored rather
                              than what was clicked. The API writes every change here to
                              audit_log with its before and after.
                            */}
                            <div style={{ borderTop: '1px solid var(--stone)', paddingTop: 14, marginTop: 8 }}>
                              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: 'var(--bl-navy)' }}>Money rules</div>

                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                                <div className="field">
                                  <label style={{ fontSize: 12 }}>Monthly salary</label>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    defaultValue={c.salaryDefault ?? ''}
                                    disabled={busy}
                                    onBlur={e => {
                                      const v = e.target.value.trim()
                                      if (v === '' || Number(v) === Number(c.salaryDefault)) return
                                      patchCohort(c, { salary_default: v }, 'Monthly salary')
                                    }}
                                  />
                                  <span className="muted" style={{ fontSize: 11 }}>218.75 school year / 250 summer</span>
                                </div>
                                <div className="field">
                                  <label style={{ fontSize: 12 }}>Reimbursement cap</label>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    defaultValue={c.reimbursementMax ?? ''}
                                    disabled={busy}
                                    onBlur={e => {
                                      const v = e.target.value.trim()
                                      if (v === '' || Number(v) === Number(c.reimbursementMax)) return
                                      patchCohort(c, { reimbursement_max: v }, 'Reimbursement cap')
                                    }}
                                  />
                                  <span className="muted" style={{ fontSize: 11 }}>per BAM per month</span>
                                </div>
                              </div>

                              <div className="field">
                                <label style={{ fontSize: 12 }}>Unspent reimbursement</label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                                  {([['forfeit', 'No carryover'], ['accumulate', 'Carries over']] as const).map(([m, text]) => (
                                    <button
                                      key={m}
                                      className={c.rolloverMode === m ? 'btn-navy' : 'btn-ghost'}
                                      style={{ fontSize: 12 }}
                                      disabled={busy}
                                      onClick={() => patchCohort(c, { rollover_mode: m }, 'Carryover')}
                                    >
                                      {text}
                                    </button>
                                  ))}
                                </div>
                                <span className="muted" style={{ fontSize: 11, marginTop: 3, display: 'block' }}>
                                  {c.rolloverMode === 'forfeit'
                                    ? 'Cap resets each month.'
                                    : c.rolloverMode === 'accumulate'
                                      ? 'Unspent rolls into next month.'
                                      : 'not set'}
                                </span>
                              </div>

                              <div className="field" style={{ marginTop: 10 }}>
                                <label style={{ fontSize: 12 }}>Receipt review</label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                                  {([[false, 'Flagged only'], [true, 'Review every one']] as const).map(([v, text]) => (
                                    <button
                                      key={String(v)}
                                      className={c.firstCohortAllReview === v ? 'btn-navy' : 'btn-ghost'}
                                      style={{ fontSize: 12 }}
                                      disabled={busy}
                                      onClick={() => patchCohort(c, { first_cohort_all_review: v }, 'Receipt review')}
                                    >
                                      {text}
                                    </button>
                                  ))}
                                </div>
                                {/* The column is named first_cohort_all_review and the old label
                                    here said "first 3 months". There is no date window in the
                                    code (lib/classify-receipt.ts): it stays on until turned off. */}
                                <span className="muted" style={{ fontSize: 11, marginTop: 3, display: 'block' }}>
                                  {c.firstCohortAllReview === true
                                    ? 'Every receipt waits for you. No timer.'
                                    : c.firstCohortAllReview === false
                                      ? 'Clean receipts auto-approve. Flagged ones still reach you.'
                                      : 'not set'}
                                </span>
                              </div>
                            </div>

                            <div style={{ borderTop: '1px solid var(--stone)', paddingTop: 14, marginTop: 14 }}>
                              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: 'var(--bl-navy)' }}>Email delivery</div>

                              <div className="field" style={{ marginBottom: 10 }}>
                                <label style={{ fontSize: 12 }}>AP invoice emails</label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                                  <button
                                    className={c.sendMode === 'dryrun' ? 'btn-navy' : 'btn-ghost'}
                                    style={{ fontSize: 12 }}
                                    disabled={busy}
                                    onClick={() => patchCohort(c, { send_mode: 'dryrun' }, 'Send mode')}
                                  >
                                    Test mode
                                  </button>
                                  <button
                                    className={c.sendMode === 'live' ? 'btn-navy' : 'btn-ghost'}
                                    style={{ fontSize: 12, background: c.sendMode === 'live' ? 'var(--green)' : undefined }}
                                    disabled={busy}
                                    onClick={() => patchCohort(c, { send_mode: 'live' }, 'Send mode')}
                                  >
                                    Live
                                  </button>
                                </div>
                                <span className="muted" style={{ fontSize: 11, marginTop: 3, display: 'block' }}>
                                  {c.sendMode === 'dryrun' ? 'Invoices generated but NOT emailed to AP' : 'Invoices WILL be emailed to AP'}
                                </span>
                              </div>

                              <div className="field">
                                <label style={{ fontSize: 12 }}>BAM invoice copies</label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                                  {(['off', 'draft', 'live'] as const).map(m => (
                                    <button
                                      key={m}
                                      className={c.bamCopyMode === m ? 'btn-navy' : 'btn-ghost'}
                                      style={{ fontSize: 12 }}
                                      disabled={busy}
                                      onClick={() => patchCohort(c, { bam_copy_mode: m }, 'BAM copies')}
                                    >
                                      {m === 'off' ? 'Off' : m === 'draft' ? 'Log only' : 'Send'}
                                    </button>
                                  ))}
                                </div>
                                <span className="muted" style={{ fontSize: 11, marginTop: 3, display: 'block' }}>
                                  {c.bamCopyMode === 'off' ? 'BAMs don\'t get a copy'
                                    : c.bamCopyMode === 'draft' ? 'Logged but not emailed (test)'
                                    : 'Each BAM gets their invoice emailed'}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Members panel */}
                          <div className="card" style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--bl-navy)' }}>
                                  Members ({members.length})
                                </span>
                                <span className="badge badge-green" style={{ fontSize: 10 }}>{activeCount} active</span>
                                {pendingCount > 0 && <span className="badge badge-yellow" style={{ fontSize: 10 }}>{pendingCount} pending</span>}
                              </div>
                              {c.id && (
                                <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setAddingBam(!addingBam)}>
                                  {addingBam ? 'Cancel' : '+ Add'}
                                </button>
                              )}
                            </div>

                            {addingBam && c.id && (
                              <div style={{ marginBottom: 12, padding: 10, background: 'var(--bl-fog, #f0f0f0)', borderRadius: 6 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Unassigned BAMs</div>
                                {unassigned.length === 0 ? (
                                  <div className="muted" style={{ fontSize: 12 }}>All BAMs are already assigned to a cohort.</div>
                                ) : (
                                  <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                                    {unassigned.map(b => (
                                      <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--stone-lt, #e5e5e5)' }}>
                                        <div>
                                          <span style={{ fontSize: 12, fontWeight: 500 }}>{b.name}</span>
                                          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>{b.email}</span>
                                        </div>
                                        <button style={{ fontSize: 11, padding: '2px 10px' }} onClick={() => addBamToCohort(c.id!, b.id)}>Add</button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {members.length === 0 ? (
                              <div className="muted" style={{ fontSize: 13, padding: '12px 0' }}>
                                No BAMs assigned yet. Click &quot;+ Add&quot; to assign BAMs.
                              </div>
                            ) : (
                              <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr style={{ borderBottom: '1px solid var(--stone)' }}>
                                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: 'var(--slate)', whiteSpace: 'nowrap' }}>Name</th>
                                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: 'var(--slate)', whiteSpace: 'nowrap' }}>Email</th>
                                      <th style={{ textAlign: 'center', padding: '4px 8px', fontWeight: 600, color: 'var(--slate)', width: 70, whiteSpace: 'nowrap' }}>Status</th>
                                      <th style={{ width: 60 }}></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {members.map(m => (
                                      <tr key={m.email} style={{ borderBottom: '1px solid var(--bl-fog)' }}>
                                        <td style={{ padding: '6px 8px', fontWeight: 500, whiteSpace: 'nowrap' }}>{m.name}</td>
                                        <td style={{ padding: '6px 8px', color: 'var(--midgray)', whiteSpace: 'nowrap' }}>{m.email}</td>
                                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                          {m.status === 'active'
                                            ? <span className="badge badge-green" style={{ fontSize: 10 }}>ACTIVE</span>
                                            : m.status === 'pending'
                                            ? <span className="badge badge-yellow" style={{ fontSize: 10 }}>PENDING</span>
                                            : <span className="badge badge-red" style={{ fontSize: 10 }}>ARCHIVED</span>}
                                        </td>
                                        <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                                          {m.id && <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--red, #ef4444)', whiteSpace: 'nowrap' }} onClick={() => { if (confirm(`Remove ${m.name} from this cohort?`)) removeBamFromCohort(c.id, m.id) }}>Remove</button>}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
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
            {cohorts.length === 0 && (
              <tr>
                <td colSpan={9}>
                  <div className="empty-state">No cohorts configured yet.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
