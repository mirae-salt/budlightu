'use client'
import { QueueLink } from '../_components/QueueLink'

import { Fragment, useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { TopBar } from '../_components/TopBar'
import { PROVINCE_CODES } from '@/lib/invoice-payload'
import { Toast, type ToastKind, type ToastNotice } from '../_components/Toast'
import { BAMS, type BamRow } from '../_lib/dummy'
import { BANK_SEED } from '@/lib/banks'
import { useCohortFilter, CohortFilterBar } from '../_components/CohortFilter'
import { useTableSort, SortTh, compareText } from '../_components/SortHeader'
import {
  type CsvRow,
  type ColumnMap,
  parseCsvGrid,
  splitHeaderAndRows,
  autoMapColumns,
  mapColumnsByContent,
  toCsvRows,
  hasRequiredColumns as columnsAreMapped,
} from '@/lib/roster-import'

const SCHOOL_LIST = [
  'U of Toronto', 'Queen\'s U', 'McMaster', 'York U', 'Western',
  'Dalhousie', 'U of Calgary', 'Mount Royal', 'U of Ottawa', 'Waterloo',
  'Toronto Met', 'Saint Mary\'s', 'Carleton', 'McGill', 'UBC',
  'U of Alberta', 'U of Manitoba', 'Simon Fraser', 'Laurier', 'Guelph',
  'Brock', 'Ryerson', 'Lakehead', 'Trent', 'UOIT',
].sort()

/**
 * The school picker.
 *
 * SCHOOL_LIST is 25 hardcoded names and the real roster is wider than that, so a
 * school the list has never heard of has to survive being looked at. It gets its
 * own option below.
 *
 * The select used to read `value={isKnown ? value : ''}`, which forced it to
 * "Select..." for exactly those schools, while rendering an option for them two
 * lines down that nothing could ever select. Grace Deets is at University of
 * Saskatchewan; the roster row said so and her edit form said "Select...". The
 * stored value was never lost (the form state kept it, so saving without
 * touching this field preserved it), but the screen said a field was empty when
 * it was not, which is the kind of thing somebody fixes by filling it in wrong.
 */
function SchoolSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = SCHOOL_LIST.includes(value)
  const custom = !known && value && value !== EMPTY_CELL ? value : null

  return (
    <select value={custom ?? (known ? value : '')} onChange={e => onChange(e.target.value)}>
      <option value="">Select…</option>
      {SCHOOL_LIST.map(s => <option key={s} value={s}>{s}</option>)}
      {custom && <option value={custom}>{custom}</option>}
    </select>
  )
}

type DbBam = {
  id: string
  first_name: string
  last_name: string
  email: string
  status: 'pending' | 'active' | 'archived'
  bank_name: string | null
  initials_resolved: string | null
  school_id: string | null
  cohort_id: string | null
  cohorts: { name: string } | null
  is_test: boolean | null
  // The mailing address. An invoice HARD BLOCKS when any of these is blank
  // (lib/invoice-payload.ts), so the roster has to be able to show and fix them.
  street: string | null
  city: string | null
  prov: string | null
  postal: string | null
}

/** Placeholder shown for an empty cell. Never sent back to the server: writing
 *  it into school_id is how a live row ended up with a dash as its school. */
const EMPTY_CELL = '—'

type Address = { street: string; city: string; prov: string; postal: string }
type FullRow = BamRow & { id: string; cohortId: string | null } & Address

type SortKey = 'name' | 'email' | 'school' | 'cohort' | 'bank' | 'invoiceCode' | 'status'

/** What a column shows, as plain text, so the order matches what is on screen.
 *  EMPTY_CELL becomes '' because a dash is punctuation: left alone it sorts
 *  above every name instead of falling to the bottom with the other blanks.
 *  A test row's status column reads TEST, so it sorts as TEST too. */
function sortValue(b: FullRow, key: SortKey): string {
  if (key === 'status') return b.isTest ? 'test' : b.status
  if (key === 'invoiceCode') return b.invoiceCode ?? ''
  const v = b[key]
  return v === EMPTY_CELL ? '' : v
}

function mapDbBam(b: DbBam): FullRow {
  return {
    id: b.id,
    name: `${b.first_name} ${b.last_name}`.trim(),
    email: b.email,
    status: b.status,
    bank: b.bank_name || EMPTY_CELL,
    invoiceCode: b.initials_resolved ? `INV-${b.initials_resolved}` : null,
    cohort: b.cohorts?.name || EMPTY_CELL,
    cohortId: b.cohort_id ?? null,
    school: b.school_id || EMPTY_CELL,
    isTest: b.is_test ?? false,
    street: b.street ?? '',
    city: b.city ?? '',
    prov: b.prov ?? '',
    postal: b.postal ?? ''
  }
}

/** Server response shape for PATCH/POST /api/admin/roster (the read-back). */
type SavedBam = {
  id: string
  first_name: string
  last_name: string
  email: string
  status: 'pending' | 'active' | 'archived'
  bank_name: string | null
  school_id: string | null
  cohort_id: string | null
  initials_resolved: string | null
  is_test: boolean | null
  street: string | null
  city: string | null
  prov: string | null
  postal: string | null
}

/** Build a table row from what the server said it stored, never from the form. */
function rowFromSaved(saved: SavedBam, cohortName: string | undefined): FullRow {
  return {
    id: saved.id,
    name: `${saved.first_name} ${saved.last_name ?? ''}`.trim(),
    email: saved.email,
    status: saved.status,
    bank: saved.bank_name || EMPTY_CELL,
    invoiceCode: saved.initials_resolved ? `INV-${saved.initials_resolved}` : null,
    cohort: cohortName || EMPTY_CELL,
    cohortId: saved.cohort_id ?? null,
    school: saved.school_id || EMPTY_CELL,
    isTest: saved.is_test ?? false,
    street: saved.street ?? '',
    city: saved.city ?? '',
    prov: saved.prov ?? '',
    postal: saved.postal ?? ''
  }
}

type EditForm = { name: string; email: string; bank: string; status: string; cohortId: string; school: string } & Address

type CohortOption = { id: string; name: string }

export default function Roster() {
  const [bams, setBams] = useState<FullRow[]>([])
  const [useDb, setUseDb] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<EditForm>({ name: '', email: '', bank: '', status: '', cohortId: '', school: '', street: '', city: '', prov: '', postal: '' })
  /** kind drives the badge colour: a failure must never render green. */
  const [editMsg, setEditMsg] = useState<ToastNotice | null>(null)
  const [saving, setSaving] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // Banking correction raised from this screen. It is a SEPARATE form from the row
  // edit on purpose: everything else here saves straight to `bams`, and this one only
  // files a request that still has to be approved with a retyped account number.
  // Sharing the Save button would have made two very different actions look the same.
  const [bankingFor, setBankingFor] = useState<string | null>(null)
  const [bankingBusy, setBankingBusy] = useState(false)
  const [bankingForm, setBankingForm] = useState({ bank: '', institution: '', transit: '', account: '', reason: '' })
  const [addForm, setAddForm] = useState({ firstName: '', lastName: '', email: '', school: '', cohortId: '', isTest: false, sendInvite: true })
  // Cohorts are held as {id, name}: the API writes cohort_id, so a name-only
  // list cannot be saved. Empty means "no cohorts in the database", and the
  // selects say so rather than offering an option that cannot be stored.
  const [cohortOptions, setCohortOptions] = useState<CohortOption[]>([])

  /* Shared with /admin/invoices so the two screens cannot disagree about which
     cohort is being looked at. See app/admin/_components/CohortFilter.tsx. */
  const { cohortFilter, hideTest, setFilters, matches } = useCohortFilter()

  // CSV import state
  const [importStep, setImportStep] = useState<'idle' | 'preview' | 'sending' | 'done'>('idle')
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvRows, setCsvRows] = useState<string[][]>([])
  const [columnMap, setColumnMap] = useState<ColumnMap>({})
  const [importCohort, setImportCohort] = useState('')
  /** False means the file brought no column names and row 1 is a person. The
   *  preview says so, because the alternative is an admin importing 57 of 58. */
  const [headerDetected, setHeaderDetected] = useState(true)
  const [importResult, setImportResult] = useState<{ ok: boolean; message?: string; created?: number; skipped?: number; errors?: string[]; email_results?: Array<{ email: string; sent: boolean; error?: string }> } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/admin/data?table=bams')
      .then(res => res.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          setBams((data as DbBam[]).map(mapDbBam))
          setUseDb(true)
        } else {
          setBams(BAMS.map((b, i) => ({ ...b, id: `dummy-${i}`, cohortId: null, street: '', city: '', prov: '', postal: '' })))
        }
      })
      .catch(() => {
        setBams(BAMS.map((b, i) => ({ ...b, id: `dummy-${i}`, cohortId: null, street: '', city: '', prov: '', postal: '' })))
      })

    fetch('/api/admin/data?table=cohorts')
      .then(res => res.json())
      .then(({ data }) => {
        setCohortOptions(data && data.length > 0 ? (data as CohortOption[]).map(c => ({ id: c.id, name: c.name })) : [])
      })
      .catch(() => setCohortOptions([]))
  }, [])

  const cohortName = (id: string | null | undefined) =>
    cohortOptions.find(c => c.id === id)?.name

  const rows = bams.filter(b => matches({ cohortId: b.cohortId, isTest: b.isTest }))

  const { sort, toggleSort } = useTableSort<SortKey>()

  /* Display order only. The counts below and every edit are computed from `rows`,
     so reordering the table cannot change what a header says or what Edit saves. */
  const sortedRows = sort ? [...rows].sort((a, b) => compareText(sortValue(a, sort.key), sortValue(b, sort.key), sort.dir)) : rows

  /* A test account's status column reads TEST, not ACTIVE or PENDING, so the
     counts have to agree with the column: a row showing TEST while being tallied
     under ACTIVE makes the header lie about a number somebody checks. Its real
     onboarding status is still there, one click away in Edit. */
  const realRows = rows.filter(b => !b.isTest)
  const active   = realRows.filter(b => b.status === 'active').length
  const pending  = realRows.filter(b => b.status === 'pending').length
  const archived = realRows.filter(b => b.status === 'archived').length
  const testCount = rows.length - realRows.length

  const badgeFor = (b: FullRow) =>
      b.isTest            ? <span className="badge" style={{ background: 'var(--amber)', color: '#fff' }}>TEST</span>
    : b.status === 'active'   ? <span className="badge badge-green">ACTIVE</span>
    : b.status === 'pending'  ? <span className="badge badge-yellow">PENDING</span>
                              : <span className="badge badge-red">ARCHIVED</span>

  /** Success notices clear themselves; failures stay until the next action. */
  function report(kind: ToastKind, text: string, action?: ToastNotice['action']) {
    const msg = { kind, text, action }
    setEditMsg(msg)
    // Only a plain success fades. 'error' and 'next' both need the reader to do
    // something, and something that vanishes after four seconds does not get done.
    if (kind === 'ok') setTimeout(() => setEditMsg(cur => (cur === msg ? null : cur)), 4000)
  }

  function startEdit(b: FullRow) {
    setEditingId(b.id)
    setEditForm({
      name: b.name,
      email: b.email,
      bank: b.bank === EMPTY_CELL ? '' : b.bank,
      status: b.status,
      cohortId: b.cohortId ?? '',
      school: b.school === EMPTY_CELL ? '' : b.school,
      street: b.street,
      city: b.city,
      prov: b.prov,
      postal: b.postal
    })
    setAdding(false)
  }

  async function submitBanking(bamId: string) {
    setBankingBusy(true)
    try {
      const res = await fetch('/api/admin/banking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bam_id: bamId,
          bank_name: bankingForm.bank,
          institution_no: bankingForm.institution,
          transit_no: bankingForm.transit,
          account_no: bankingForm.account,
          reason: bankingForm.reason
        })
      })
      const j = await res.json()
      if (!res.ok || !j.ok) {
        report('error', j.message || res.statusText)
        return
      }
      // The request IS saved; the banking is not applied. This was reported as an error
      // at first, so a screen that had worked perfectly announced "That did not go
      // through". 'next' is the state that says both true things at once.
      report('next', j.message, { label: 'Open Banking requests', href: '/admin/banking-requests' })
      setBankingFor(null)
      setBankingForm({ bank: '', institution: '', transit: '', account: '', reason: '' })
    } catch (e) {
      report('error', `Could not save the correction: ${(e as Error).message}`)
    } finally {
      setBankingBusy(false)
    }
  }

  async function saveEdit(id: string) {
    const [firstName, ...rest] = editForm.name.trim().split(' ')
    const lastName = rest.join(' ')

    // Bank and cohort used to be written into local state without ever being
    // sent, so the row visibly changed and the badge said saved while the
    // database kept the old bank name (the input to the institution-code lookup
    // that routes payment) and the old cohort.
    const current = bams.find(b => b.id === id)
    const body: Record<string, unknown> = {
      id,
      first_name: firstName,
      last_name: lastName,
      email: editForm.email,
      status: editForm.status,
      // null, not the dash placeholder the table renders for an empty cell.
      school_id: editForm.school.trim() || null
    }
    // Bank is sent only when it changed. The server refuses a name that is not
    // in the institution-code lookup, and a row that already holds an unmapped
    // name must not block an unrelated edit to the email or status.
    const currentBank = current && current.bank !== EMPTY_CELL ? current.bank : ''
    if (editForm.bank.trim() !== currentBank.trim()) {
      body.bank_name = editForm.bank.trim() || null
    }
    if (editForm.cohortId && editForm.cohortId !== (current?.cohortId ?? '')) {
      body.cohort_id = editForm.cohortId
    }
    // Address fields, sent only when changed. The server validates `prov` against the
    // same table computeHst uses, so a bad code is rejected here with a sentence
    // instead of throwing during the monthly invoice run. An empty value is sent as
    // null rather than '' so the invoice block reports it as missing, not blank.
    for (const k of ['street', 'city', 'prov', 'postal'] as const) {
      const next = editForm[k].trim()
      if (next !== (current?.[k] ?? '').trim()) body[k] = next || null
    }

    setSaving(true)
    try {
      const resp = await fetch('/api/admin/roster', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const j = await resp.json()
      if (!resp.ok || !j.ok) {
        report('error', `Save failed: ${j.message || resp.statusText}`)
        return
      }
      // Only what the server read back goes into the table.
      const saved = j.bam as SavedBam
      setBams(prev => prev.map(b => b.id === id ? rowFromSaved(saved, cohortName(saved.cohort_id) ?? b.cohort) : b))
      setEditingId(null)
      // Changing the bank re-derives its institution number in a second, encrypted
      // write. That can fail on its own, and the route says so via `warning` — a clean
      // "Saved" there would hide a row whose PDF names one bank and pays another.
      // The invoice note is the point of the address fields: an edit that stops at the
      // roster row leaves the PDF AP receives showing the old address, and until
      // 2026-09-17 it did exactly that with no way to tell.
      const note = typeof j.invoice_note === 'string' ? j.invoice_note : ''
      report(
        j.warning ? 'error' : 'ok',
        j.warning
          ? `Saved, but: ${j.warning}${note ? ` ${note}` : ''}`
          : note ? `Saved. ${note}` : 'Saved'
      )
    } catch (e) {
      report('error', `Save failed: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  async function addBam() {
    if (!addForm.firstName.trim() || !addForm.email.trim() || !addForm.cohortId) return
    setSaving(true)
    try {
      const resp = await fetch('/api/admin/roster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: addForm.firstName,
          last_name: addForm.lastName,
          email: addForm.email,
          cohort_id: addForm.cohortId,
          school_id: addForm.school.trim() || null,
          is_test: addForm.isTest,
          send_invite: addForm.sendInvite
        })
      })
      const j = await resp.json()
      if (!resp.ok || !j.ok) {
        report('error', `Not added: ${j.message || resp.statusText}`)
        return
      }
      const saved = j.bam as SavedBam
      // The row appears only because the database has it. When the table was
      // showing sample data (no DB rows yet), reload so real and sample rows are
      // never mixed.
      if (useDb) {
        setBams(prev => [...prev, rowFromSaved(saved, j.cohort_name ?? cohortName(saved.cohort_id))])
      } else {
        const refetch = await fetch('/api/admin/data?table=bams').then(r => r.json()).catch(() => null)
        if (refetch?.data?.length) {
          setBams((refetch.data as DbBam[]).map(mapDbBam))
          setUseDb(true)
        } else {
          setBams([rowFromSaved(saved, j.cohort_name ?? cohortName(saved.cohort_id))])
          setUseDb(true)
        }
      }
      setAddForm({ firstName: '', lastName: '', email: '', school: '', cohortId: '', isTest: false, sendInvite: true })
      setAdding(false)
      // Say what happened to the EMAIL, not just to the row. The old message told the
      // admin to send an invite from Edit even when one had just gone out, and the
      // route's warning about a failed send was the only clue either way.
      if (j.warning) {
        report('error', `Added ${saved.email}, but: ${j.warning}`)
      } else if (j.invite_requested && j.email_sent) {
        report('ok', `Added ${saved.email} and emailed their invite (${j.email_provider}).`)
      } else if (j.invite_requested) {
        report('error', `Added ${saved.email} but the invite email did not send. Use Edit to retry.`)
      } else {
        report('ok', `Added ${saved.email}. No invite sent -- use Send Invite in Edit when you are ready.`)
      }
    } catch (e) {
      report('error', `Not added: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  // --- CSV import handlers ---

  /** One landing point for both file formats, so Excel and CSV cannot disagree
   *  about whether the first row was a person. */
  function loadGrid(grid: string[][]) {
    const { headers, rows: dataRows, headerDetected } = splitHeaderAndRows(grid)
    if (dataRows.length === 0) {
      report('error', 'Could not parse that file. Check the format.')
      return
    }
    setCsvHeaders(headers)
    setCsvRows(dataRows)
    setHeaderDetected(headerDetected)
    setColumnMap(headerDetected ? autoMapColumns(headers) : mapColumnsByContent(dataRows, headers.length))
    setImportStep('preview')
    setImportResult(null)
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const isExcel = /\.xlsx?$/i.test(file.name)

    if (isExcel) {
      const reader = new FileReader()
      reader.onload = () => {
        const wb = XLSX.read(reader.result, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const json = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 })
        loadGrid(json as string[][])
      }
      reader.readAsArrayBuffer(file)
    } else {
      const reader = new FileReader()
      reader.onload = () => {
        loadGrid(parseCsvGrid(reader.result as string))
      }
      reader.readAsText(file)
    }
    e.target.value = ''
  }

  const mappedCsvRows = (): CsvRow[] => toCsvRows(csvRows, columnMap)
  const hasRequiredColumns = columnsAreMapped(columnMap)

  async function submitImport() {
    if (!importCohort) return
    setImportStep('sending')
    try {
      const res = await fetch('/api/admin/bulk-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cohort_id: importCohort, bams: mappedCsvRows() })
      })
      const result = await res.json()
      setImportResult(result)
      setImportStep('done')
      if (result.ok) {
        fetch('/api/admin/data?table=bams')
          .then(r => r.json())
          .then(({ data }) => { if (data?.length) setBams((data as DbBam[]).map(mapDbBam)) })
      }
    } catch (err) {
      setImportResult({ ok: false, errors: ['Network error'] })
      setImportStep('done')
    }
  }

  function resetImport() {
    setImportStep('idle')
    setCsvHeaders([])
    setCsvRows([])
    setColumnMap({})
    setImportCohort('')
    setImportResult(null)
    setHeaderDetected(true)
  }

  return (
    <>
      <TopBar crumbs={['Roster', 'BAMs']} />

      {/* Moved here from the sidebar. A banking change is a change to one of these rows, and
          it is the roster page that shows what it would change. */}
      <QueueLink
        href="/admin/banking-requests"
        title="Banking changes"
        countKey="banking"
        labelSome={n => `${n} waiting for your approval`}
        labelNone="none waiting"
      />

      {/* Fixed toast: an inline badge beside the button was too easy to miss. */}
      <Toast notice={editMsg} onDismiss={() => setEditMsg(null)} />

      {inviteUrl && (
        <div className="surface" style={{ marginBottom: 12, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Onboarding link</span>
            <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setInviteUrl(null)}>Dismiss</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <a href={inviteUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all', flex: 1, minWidth: 240 }}>{inviteUrl}</a>
            <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => navigator.clipboard.writeText(inviteUrl)}>Copy</button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Send this manually if the email link does not work. One-time use.
          </div>
        </div>
      )}

      <div className="surface">
        <div className="surface-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="surface-title" style={{ marginRight: 4 }}>BAM roster</span>
            <span className="badge badge-green">ACTIVE · {active}</span>
            <span className="badge badge-yellow">PENDING · {pending}</span>
            <span className="badge badge-red">ARCHIVED · {archived}</span>
            {testCount > 0 && (
              <span className="badge" style={{ background: 'var(--amber)', color: '#fff' }}>TEST · {testCount}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx,.xls" onChange={handleFileSelect} style={{ display: 'none' }} />
            <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
              Import CSV / Excel
            </button>
            <button onClick={() => { setAdding(a => !a); setEditingId(null) }}>
              {adding ? 'Cancel' : '+ Add BAM'}
            </button>
          </div>
        </div>

        {/* CSV Import Preview */}
        {importStep !== 'idle' && (
          <div className="card" style={{ marginBottom: 16 }}>
            {importStep === 'preview' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>Import preview: {csvRows.length} rows</h3>
                  <button className="btn-ghost" onClick={resetImport} style={{ fontSize: 12 }}>Cancel</button>
                </div>

                {!headerDetected && (
                  <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 6, background: 'var(--bl-silver)', fontSize: 12.5 }}>
                    <strong>No column names in this file.</strong> Row 1 is a person, so all
                    {' '}{csvRows.length} rows are included. Set the columns below.
                  </div>
                )}

                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Column mapping</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {csvHeaders.map((h, i) => (
                      <div key={i} style={{ fontSize: 12 }}>
                        <div className="muted" style={{ marginBottom: 2 }}>{h}</div>
                        <select
                          value={columnMap[i] ?? ''}
                          onChange={e => setColumnMap(m => ({ ...m, [i]: (e.target.value || null) as keyof CsvRow | null }))}
                          style={{ fontSize: 12, padding: '3px 6px' }}
                        >
                          <option value="">skip</option>
                          <option value="first_name">First name</option>
                          <option value="last_name">Last name</option>
                          <option value="full_name">Full name</option>
                          <option value="email">Email</option>
                          <option value="school">School</option>
                        </select>
                      </div>
                    ))}
                  </div>
                  {!hasRequiredColumns && (
                    <div style={{ color: '#b91c1c', fontSize: 12, marginTop: 6 }}>Map at least a name (first + last, or full name) and email</div>
                  )}
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Cohort</label>
                  <select value={importCohort} onChange={e => setImportCohort(e.target.value)} style={{ maxWidth: 240 }}>
                    <option value="">Select cohort…</option>
                    {cohortOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>

                {hasRequiredColumns && (
                  <div className="table-scroll" style={{ maxHeight: 260 }}>
                    <table className="admin-table" style={{ fontSize: 12.5 }}>
                      <thead>
                        <tr>
                          <th>#</th><th>First</th><th>Last</th><th>Email</th><th>School</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mappedCsvRows().slice(0, 20).map((r, i) => (
                          <tr key={i}>
                            <td className="muted">{i + 1}</td>
                            <td>{r.first_name}</td>
                            <td>{r.last_name}</td>
                            <td className="muted">{r.email}</td>
                            <td className="muted">{r.school || '—'}</td>
                          </tr>
                        ))}
                        {mappedCsvRows().length > 20 && (
                          <tr><td colSpan={5} className="muted" style={{ textAlign: 'center' }}>+{mappedCsvRows().length - 20} more</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={submitImport} disabled={!hasRequiredColumns || !importCohort || mappedCsvRows().length === 0}>
                    Import {mappedCsvRows().length} BAMs + send invites
                  </button>
                  <button className="btn-ghost" onClick={resetImport}>Cancel</button>
                </div>
              </>
            )}

            {importStep === 'sending' && (
              <div style={{ padding: 24, textAlign: 'center' }}>
                <div style={{ fontSize: 14 }}>Creating accounts and sending invite emails…</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>This may take a moment for large batches</div>
              </div>
            )}

            {importStep === 'done' && importResult && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>
                    {importResult.ok ? 'Import complete' : 'Import failed'}
                  </h3>
                  <button className="btn-ghost" onClick={resetImport} style={{ fontSize: 12 }}>Close</button>
                </div>

                {importResult.ok && (
                  <div style={{ fontSize: 13 }}>
                    <span className="badge badge-green" style={{ marginRight: 8 }}>{importResult.created} created</span>
                    {(importResult.skipped ?? 0) > 0 && (
                      <span className="badge badge-yellow" style={{ marginRight: 8 }}>{importResult.skipped} skipped</span>
                    )}
                  </div>
                )}

                {importResult.message && !importResult.ok && (
                  <div style={{ marginTop: 8, fontSize: 13, color: '#b91c1c', fontWeight: 600 }}>{importResult.message}</div>
                )}

                {importResult.errors && importResult.errors.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#b91c1c', maxHeight: 120, overflowY: 'auto' }}>
                    {importResult.errors.map((e, i) => <div key={i}>{e}</div>)}
                  </div>
                )}

                {importResult.email_results && (
                  <div style={{ marginTop: 12, fontSize: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Email results:</div>
                    <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                      {importResult.email_results.map((r, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                          <span className={r.sent ? 'badge badge-green' : 'badge badge-red'} style={{ fontSize: 10 }}>
                            {r.sent ? 'SENT' : 'FAILED'}
                          </span>
                          <span className="muted">{r.email}</span>
                          {r.error && <span style={{ color: '#b91c1c' }}>{r.error}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <button onClick={resetImport} style={{ marginTop: 12 }}>Done</button>
              </>
            )}
          </div>
        )}

        {adding && (
          <div className="card" style={{ marginBottom: 16, maxWidth: 520 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>First name</label>
                <input value={addForm.firstName} onChange={e => setAddForm(f => ({ ...f, firstName: e.target.value }))} placeholder="First name" />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Last name</label>
                <input value={addForm.lastName} onChange={e => setAddForm(f => ({ ...f, lastName: e.target.value }))} placeholder="Last name" />
              </div>
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={addForm.email} onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))} placeholder="bam@school.edu" />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>School</label>
                <SchoolSelect value={addForm.school} onChange={v => setAddForm(f => ({ ...f, school: v }))} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Cohort</label>
                <select value={addForm.cohortId} onChange={e => setAddForm(f => ({ ...f, cohortId: e.target.value }))}>
                  <option value="">Select…</option>
                  {cohortOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {cohortOptions.length === 0 && (
                  <span className="muted" style={{ fontSize: 11, marginTop: 3, display: 'block' }}>
                    No cohorts found. Create one on the Cohorts page first.
                  </span>
                )}
              </div>
            </div>
            {/* Defaults to on: adding a BAM is normally the moment you invite them, and
                the CSV import already sends automatically. It stays a checkbox because
                sending mail is an outward action an admin should be able to decline. */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', margin: '4px 0 0' }}>
              <input type="checkbox" checked={addForm.sendInvite} onChange={e => setAddForm(f => ({ ...f, sendInvite: e.target.checked }))} />
              Email them the invite now
              <span style={{ fontSize: 11, color: 'var(--midgray)' }}>-- uncheck to add the row only</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', margin: '4px 0 8px' }}>
              <input type="checkbox" checked={addForm.isTest} onChange={e => setAddForm(f => ({ ...f, isTest: e.target.checked }))} />
              Test account
              {/*
                Was: "excluded from reports and AP sends". That was false. Grepped 2026-08-13:
                scheduler-generate, send-ap and batch-approve contain no read of `is_test` at all, and
                the dashboard queries in api/admin/data filter on status only. A test row IS invoiced
                and IS counted in the totals. roster/route.ts:197 says so in a comment.

                It mattered because that label is the reason somebody would tick this box on a
                live-cohort row, believing it made the row harmless.
              */}
              <span style={{ fontSize: 11, color: 'var(--midgray)' }}>
                Can upload after the deadline. Still invoiced, so keep it in the TEST cohort.
              </span>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={addBam}
                disabled={saving || !addForm.firstName.trim() || !addForm.email.trim() || !addForm.cohortId}
              >
                {saving ? 'Adding...' : (addForm.sendInvite ? 'Add and send invite' : 'Add to roster')}
              </button>
              <button className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        )}

        <CohortFilterBar
          cohortFilter={cohortFilter}
          hideTest={hideTest}
          setFilters={setFilters}
          cohortOptions={cohortOptions}
          showNoCohort={bams.some(b => !b.cohortId)}
        />

        <div className="table-scroll">
          {/* one-line: every row the same height. Before this, rows alternated 54px and
              71px depending on whether that BAM's school, bank or cohort happened to
              wrap. School and email are the only two columns long enough to need
              cutting, and both keep a title so the full value is still readable. */}
          <table className="admin-table one-line">
            <thead>
              <tr>
                <SortTh sortKey="name" sort={sort} onSort={toggleSort}>Name</SortTh>
                <SortTh sortKey="email" sort={sort} onSort={toggleSort}>Email</SortTh>
                <SortTh sortKey="school" sort={sort} onSort={toggleSort}>School</SortTh>
                <SortTh sortKey="cohort" sort={sort} onSort={toggleSort}>Cohort</SortTh>
                <SortTh sortKey="bank" sort={sort} onSort={toggleSort}>Bank</SortTh>
                <SortTh sortKey="invoiceCode" sort={sort} onSort={toggleSort}>Invoice #</SortTh>
                <SortTh sortKey="status" sort={sort} onSort={toggleSort}>Status</SortTh>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted wrap" style={{ padding: 24, textAlign: 'center' }}>
                    {bams.length === 0 ? 'No BAMs on the roster yet.' : 'No BAMs match this filter.'}
                  </td>
                </tr>
              )}
              {sortedRows.map((b) => (
                <Fragment key={b.id}>
                  <tr>
                    {/* The TEST marker used to sit here as well. It lives in the status
                        column now, which is the column somebody scans for it. */}
                    <td style={{ fontWeight: 600 }}>
                      <span className="cell-trunc" style={{ '--trunc': '21ch' } as React.CSSProperties} title={b.name}>{b.name}</span>
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>
                      <span className="cell-trunc" style={{ '--trunc': '20ch' } as React.CSSProperties} title={b.email}>{b.email}</span>
                    </td>
                    <td className="muted">
                      <span className="cell-trunc" style={{ '--trunc': '16ch' } as React.CSSProperties} title={b.school}>{b.school}</span>
                    </td>
                    <td className="muted">{b.cohort}</td>
                    <td>
                      <span className="cell-trunc" style={{ '--trunc': '16ch' } as React.CSSProperties} title={b.bank}>{b.bank}</span>
                    </td>
                    <td style={{ fontFamily: 'monospace', color: 'var(--bl-navy)', fontWeight: 600 }}>
                      {b.invoiceCode ?? <span className="muted">—</span>}
                    </td>
                    <td>{badgeFor(b)}</td>
                    <td>
                      <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => startEdit(b)}>
                        Edit
                      </button>
                    </td>
                  </tr>

                  {editingId === b.id && (
                    <tr>
                      {/* `wrap` opts this cell out of the table's one-line rule. Without it the
                          edit panel's help text ran on a single line off the right edge: the
                          rule is for list rows, and this cell holds a form, not a value. */}
                      <td colSpan={8} className="wrap" style={{ background: 'var(--bl-silver)', padding: 16 }}>
                        <div className="card" style={{ maxWidth: 520 }}>
                          <div style={{ display: 'flex', gap: 12 }}>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Name</label>
                              <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Email</label>
                              <input type="email" value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} />
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 12 }}>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Bank</label>
                              <select value={editForm.bank} onChange={e => setEditForm(f => ({ ...f, bank: e.target.value }))}>
                                <option value="">Select…</option>
                                {editForm.bank && !BANK_SEED.some(x => x.displayName === editForm.bank) && (
                                  <option value={editForm.bank}>{editForm.bank} (not in the lookup)</option>
                                )}
                                {BANK_SEED.map(b => <option key={b.normalized} value={b.displayName}>{b.displayName}</option>)}
                              </select>
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Cohort</label>
                              <select value={editForm.cohortId} onChange={e => setEditForm(f => ({ ...f, cohortId: e.target.value }))}>
                                <option value="">Select…</option>
                                {cohortOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                              </select>
                              {cohortOptions.length === 0 && (
                                <span className="muted" style={{ fontSize: 11, marginTop: 3, display: 'block' }}>
                                  Cohorts could not be loaded, so the cohort cannot be changed here.
                                </span>
                              )}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 12 }}>
                            <div className="field" style={{ flex: 1 }}>
                              <label>School</label>
                              <SchoolSelect value={editForm.school} onChange={v => setEditForm(f => ({ ...f, school: v }))} />
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Status</label>
                              <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}>
                                <option value="active">Active</option>
                                <option value="pending">Pending</option>
                                <option value="archived">Archived</option>
                              </select>
                            </div>
                          </div>
                          {/* Mailing address. An invoice HARD BLOCKS when any of the four
                              is blank, and until now they were only settable during
                              onboarding, which refuses a BAM who is no longer 'pending' --
                              so a typo here stopped an invoice with no way to fix it. */}
                          <div style={{ display: 'flex', gap: 12 }}>
                            <div className="field" style={{ flex: 2 }}>
                              <label>Street</label>
                              <input value={editForm.street} onChange={e => setEditForm(f => ({ ...f, street: e.target.value }))} placeholder="123 King St W, Apt 4" />
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label>City</label>
                              <input value={editForm.city} onChange={e => setEditForm(f => ({ ...f, city: e.target.value }))} placeholder="Toronto" />
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 12 }}>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Province</label>
                              {/* A select, not free text: computeHst throws on a code outside
                                  this list, which would fail the whole monthly run. */}
                              <select value={editForm.prov} onChange={e => setEditForm(f => ({ ...f, prov: e.target.value }))}>
                                <option value="">Select...</option>
                                {PROVINCE_CODES.map(p => <option key={p} value={p}>{p}</option>)}
                              </select>
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label>Postal code</label>
                              <input value={editForm.postal} onChange={e => setEditForm(f => ({ ...f, postal: e.target.value }))} placeholder="M5V 1A1" />
                            </div>
                          </div>
                          {(!editForm.street.trim() || !editForm.city.trim() || !editForm.prov.trim() || !editForm.postal.trim()) && (
                            <span className="muted" style={{ fontSize: 11, marginBottom: 8, display: 'block', color: '#b45309' }}>
                              An invoice cannot be generated until all four address fields are filled in.
                            </span>
                          )}

                          {/* BANKING. Not part of Save.
                              The account number is the one field on this screen that
                              decides where money lands, and the only protection against a
                              typo in it has never been who types it -- it is that the
                              digits get entered twice and compared. So this files a
                              request and the approval screen asks for them again. */}
                          <div style={{ borderTop: '1.5px solid var(--stone)', marginTop: 18, paddingTop: 14, marginBottom: 18 }}>
                            {bankingFor !== b.id ? (
                              <div>
                                {/* A label and a line of help, not a lone button.
                                    Styled blue and unlabelled it read as a link wedged
                                    above Save, and nobody could tell it was a section of
                                    its own. btn-ghost's own navy is left alone now. */}
                                <label style={{ marginBottom: 2 }}>Banking</label>
                                <p className="muted" style={{ fontSize: 12, margin: '0 0 10px', lineHeight: 1.5 }}>
                                  Account, transit and institution numbers. These are not part of Save:
                                  changing them needs a second confirmation.
                                </p>
                                <button
                                  className="btn-ghost"
                                  style={{ fontSize: 12 }}
                                  onClick={() => {
                                    setBankingFor(b.id)
                                    setBankingForm({
                                      bank: b.bank === EMPTY_CELL ? '' : b.bank,
                                      institution: '', transit: '', account: '', reason: ''
                                    })
                                  }}
                                >
                                  Correct their banking details
                                </button>
                              </div>
                            ) : (
                              <div>
                                <label style={{ marginBottom: 2 }}>Banking</label>
                                <p className="muted" style={{ fontSize: 12, margin: '0 0 12px', lineHeight: 1.5 }}>
                                  Use this when the BAM has told you the right numbers and you do not want to
                                  wait for them to file it themselves. Saving here does <strong>not</strong> change
                                  anything yet. It creates a request on the Banking requests page, where you
                                  retype the account number to apply it. {b.name} is emailed once it is applied.
                                </p>
                                <div style={{ display: 'flex', gap: 12 }}>
                                  <div className="field" style={{ flex: 2 }}>
                                    <label>Bank</label>
                                    <select
                                      value={bankingForm.bank}
                                      onChange={e => setBankingForm(f => ({ ...f, bank: e.target.value }))}
                                    >
                                      <option value="">Select…</option>
                                      {BANK_SEED.map(x => <option key={x.normalized} value={x.displayName}>{x.displayName}</option>)}
                                    </select>
                                  </div>
                                  <div className="field" style={{ flex: 1 }}>
                                    <label>Institution</label>
                                    <input
                                      value={bankingForm.institution}
                                      onChange={e => setBankingForm(f => ({ ...f, institution: e.target.value }))}
                                      placeholder="003"
                                      inputMode="numeric"
                                    />
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: 12 }}>
                                  <div className="field" style={{ flex: 1 }}>
                                    <label>Transit</label>
                                    <input
                                      value={bankingForm.transit}
                                      onChange={e => setBankingForm(f => ({ ...f, transit: e.target.value }))}
                                      placeholder="00002"
                                      inputMode="numeric"
                                    />
                                  </div>
                                  <div className="field" style={{ flex: 1 }}>
                                    <label>Account</label>
                                    <input
                                      value={bankingForm.account}
                                      onChange={e => setBankingForm(f => ({ ...f, account: e.target.value }))}
                                      placeholder="5134481"
                                      inputMode="numeric"
                                    />
                                  </div>
                                </div>
                                <div className="field">
                                  <label>Where did these numbers come from?</label>
                                  <input
                                    value={bankingForm.reason}
                                    onChange={e => setBankingForm(f => ({ ...f, reason: e.target.value }))}
                                    placeholder="BAM corrected it on the INV-LB1 invoice thread, Sept 17"
                                  />
                                </div>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                  <button onClick={() => submitBanking(b.id)} disabled={bankingBusy}>
                                    {bankingBusy ? 'Saving…' : 'Create the correction'}
                                  </button>
                                  {/* Not "Cancel": the row's own Cancel sits a few pixels below
                                      it, and two of them stacked left no way to tell which
                                      one abandoned which edit. */}
                                  <button className="btn-ghost" onClick={() => setBankingFor(null)}>Close</button>
                                  <a
                                    href="/admin/banking-requests"
                                    style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--bl-blue)' }}
                                  >
                                    Banking requests
                                  </a>
                                </div>
                              </div>
                            )}
                          </div>

                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <button onClick={() => saveEdit(b.id)} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                            <button className="btn-ghost" onClick={() => setEditingId(null)}>Cancel</button>
                            {b.status === 'pending' && (
                              <button
                                className="btn-ghost"
                                disabled={inviting}
                                style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--bl-blue)' }}
                                onClick={async () => {
                                  setInviting(true)
                                  try {
                                    const res = await fetch('/api/admin/invite', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ bam_id: b.id })
                                    })
                                    const j = await res.json()
                                    if (j.ok) {
                                      setInviteUrl(j.invite_url ?? null)
                                      if (j.email_sent) report('ok', `Invite sent to ${b.email}`)
                                      else report('error', `Invite created but the email failed: ${j.email_error}. Copy the link below and send it yourself.`)
                                    } else {
                                      report('error', `Invite failed: ${j.message}`)
                                    }
                                  } catch (e) {
                                    report('error', `Invite failed: ${(e as Error).message}`)
                                  } finally {
                                    setInviting(false)
                                  }
                                }}
                              >
                                {inviting ? 'Sending...' : 'Send Invite'}
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="wrap">
                    <div className="empty-state">No BAMs found. Sign in as admin to view roster data.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
