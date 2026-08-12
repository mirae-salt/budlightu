'use client'
import { QueueLink } from '../_components/QueueLink'

import { Fragment, useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { TopBar } from '../_components/TopBar'
import { PROVINCE_CODES } from '@/lib/invoice-payload'
import { Toast } from '../_components/Toast'
import { BAMS, type BamRow } from '../_lib/dummy'
import { BANK_SEED } from '@/lib/banks'

const SCHOOL_LIST = [
  'U of Toronto', 'Queen\'s U', 'McMaster', 'York U', 'Western',
  'Dalhousie', 'U of Calgary', 'Mount Royal', 'U of Ottawa', 'Waterloo',
  'Toronto Met', 'Saint Mary\'s', 'Carleton', 'McGill', 'UBC',
  'U of Alberta', 'U of Manitoba', 'Simon Fraser', 'Laurier', 'Guelph',
  'Brock', 'Ryerson', 'Lakehead', 'Trent', 'UOIT',
].sort()

function SchoolSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isKnown = SCHOOL_LIST.includes(value)

  return (
    <select value={isKnown ? value : ''} onChange={e => onChange(e.target.value)}>
      <option value="">Select…</option>
      {SCHOOL_LIST.map(s => <option key={s} value={s}>{s}</option>)}
      {!isKnown && value && value !== '—' && (
        <option value={value}>{value}</option>
      )}
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

// --- CSV parsing ---
type CsvRow = { first_name: string; last_name: string; email: string; school?: string; full_name?: string }

const COLUMN_ALIASES: Record<string, keyof CsvRow> = {
  'first_name': 'first_name', 'first name': 'first_name', 'firstname': 'first_name', 'first': 'first_name', 'prénom': 'first_name',
  'last_name': 'last_name', 'last name': 'last_name', 'lastname': 'last_name', 'last': 'last_name', 'surname': 'last_name', 'nom': 'last_name',
  'email': 'email', 'email address': 'email', 'e-mail': 'email', 'mail': 'email',
  'full_name': 'full_name', 'full name': 'full_name', 'fullname': 'full_name', 'name': 'full_name',
  'school': 'school', 'school_id': 'school', 'university': 'school', 'campus': 'school',
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return { headers: [], rows: [] }
  const headers = splitCsvLine(lines[0])
  const rows = lines.slice(1).map(splitCsvLine).filter(r => r.some(c => c.trim()))
  return { headers, rows }
}

function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue }
    if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue }
    current += ch
  }
  result.push(current.trim())
  return result
}

function autoMapColumns(headers: string[]): Record<number, keyof CsvRow | null> {
  const mapping: Record<number, keyof CsvRow | null> = {}
  const used = new Set<keyof CsvRow>()
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase().trim()
    const mapped = COLUMN_ALIASES[h]
    if (mapped && !used.has(mapped)) {
      mapping[i] = mapped
      used.add(mapped)
    } else {
      mapping[i] = null
    }
  }
  return mapping
}

type CohortOption = { id: string; name: string }

export default function Roster() {
  const [bams, setBams] = useState<FullRow[]>([])
  const [useDb, setUseDb] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<EditForm>({ name: '', email: '', bank: '', status: '', cohortId: '', school: '', street: '', city: '', prov: '', postal: '' })
  /** kind drives the badge colour: a failure must never render green. */
  const [editMsg, setEditMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addForm, setAddForm] = useState({ firstName: '', lastName: '', email: '', school: '', cohortId: '', isTest: false, sendInvite: true })
  // Cohorts are held as {id, name}: the API writes cohort_id, so a name-only
  // list cannot be saved. Empty means "no cohorts in the database", and the
  // selects say so rather than offering an option that cannot be stored.
  const [cohortOptions, setCohortOptions] = useState<CohortOption[]>([])

  // CSV import state
  const [importStep, setImportStep] = useState<'idle' | 'preview' | 'sending' | 'done'>('idle')
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvRows, setCsvRows] = useState<string[][]>([])
  const [columnMap, setColumnMap] = useState<Record<number, keyof CsvRow | null>>({})
  const [importCohort, setImportCohort] = useState('')
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

  const rows = bams

  const active   = rows.filter(b => b.status === 'active').length
  const pending  = rows.filter(b => b.status === 'pending').length
  const archived = rows.filter(b => b.status === 'archived').length

  const badgeFor = (s: 'active' | 'pending' | 'archived') =>
      s === 'active'   ? <span className="badge badge-green">ACTIVE</span>
    : s === 'pending'  ? <span className="badge badge-yellow">PENDING</span>
                       : <span className="badge badge-red">ARCHIVED</span>

  /** Success notices clear themselves; failures stay until the next action. */
  function report(kind: 'ok' | 'error', text: string) {
    const msg = { kind, text }
    setEditMsg(msg)
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
      report(j.warning ? 'error' : 'ok', j.warning ? `Saved, but: ${j.warning}` : 'Saved')
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
        const nonEmpty = (json as string[][]).filter(r => r.some(c => c != null && String(c).trim()))
        if (nonEmpty.length < 2) {
          report('error', 'Could not parse that file. Check the format.')
          return
        }
        const headers = nonEmpty[0].map(h => String(h ?? ''))
        const dataRows = nonEmpty.slice(1).map(r => headers.map((_, i) => String(r[i] ?? '').trim()))
        setCsvHeaders(headers)
        setCsvRows(dataRows)
        setColumnMap(autoMapColumns(headers))
        setImportStep('preview')
        setImportResult(null)
      }
      reader.readAsArrayBuffer(file)
    } else {
      const reader = new FileReader()
      reader.onload = () => {
        const text = reader.result as string
        const { headers, rows: dataRows } = parseCsv(text)
        if (headers.length === 0) {
          report('error', 'Could not parse that file. Check the format.')
          return
        }
        setCsvHeaders(headers)
        setCsvRows(dataRows)
        setColumnMap(autoMapColumns(headers))
        setImportStep('preview')
        setImportResult(null)
      }
      reader.readAsText(file)
    }
    e.target.value = ''
  }

  function mappedCsvRows(): CsvRow[] {
    return csvRows.map(row => {
      const out: Record<string, string> = {}
      for (let i = 0; i < row.length; i++) {
        const field = columnMap[i]
        if (field) out[field] = row[i]
      }
      if (out.full_name && !out.first_name) {
        const parts = out.full_name.trim().split(/\s+/)
        out.first_name = parts[0] || ''
        out.last_name = parts.slice(1).join(' ') || ''
      }
      return out as unknown as CsvRow
    }).filter(r => r.first_name && r.email)
  }

  const cols = Object.values(columnMap)
  const hasName = (cols.includes('first_name') && cols.includes('last_name')) || cols.includes('full_name')
  const hasRequiredColumns = hasName && cols.includes('email')

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
              <span style={{ fontSize: 11, color: 'var(--midgray)' }}>-- excluded from reports and AP sends</span>
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

        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>School</th><th>Cohort</th><th>Bank</th><th>Invoice code</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <Fragment key={b.id}>
                  <tr>
                    <td style={{ fontWeight: 600 }}>
                      {b.name}
                      {b.isTest && <span className="badge" style={{ marginLeft: 6, background: 'var(--amber)', color: '#fff', fontSize: 9, padding: '1px 5px', verticalAlign: 'middle' }}>TEST</span>}
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{b.email}</td>
                    <td className="muted">{b.school}</td>
                    <td className="muted">{b.cohort}</td>
                    <td>{b.bank}</td>
                    <td style={{ fontFamily: 'monospace', color: 'var(--bl-navy)', fontWeight: 600 }}>
                      {b.invoiceCode ?? <span className="muted">—</span>}
                    </td>
                    <td>{badgeFor(b.status)}</td>
                    <td>
                      <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => startEdit(b)}>
                        Edit
                      </button>
                    </td>
                  </tr>

                  {editingId === b.id && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--bl-silver)', padding: 16 }}>
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
                  <td colSpan={8}>
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
