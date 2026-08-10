'use client'
import { useRef, useState, useEffect, useCallback } from 'react'
import { browserClient } from '@/lib/supabase-browser'
import { resolveBamId } from '@/lib/portal-bam'

const MAX_MB = 10
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

const PROGRAM_START_MONTH = 8 // September (0-indexed)
const PROGRAM_START_YEAR = 2026
const PROGRAM_MONTHS = 8 // Sept through April

type MonthOption = { value: string; label: string; tag?: string; isCurrent?: boolean; isSubmittable?: boolean }

/** UTC month key, matching lib/period.ts. `new Date(y, m, 1).toISOString()` is a
 *  LOCAL midnight, which at a negative UTC offset lands on the last day of the
 *  previous month, so a September receipt would be filed under August. */
function monthValue(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}-01`
}

/**
 * Month choices for the selector.
 *
 * The list used to be exactly the 8 hardcoded program months (Sept 2026 - Apr
 * 2027), which broke in two ways:
 *   - Before the program starts, nothing in the list is acceptable to the server,
 *     so every submit failed with "You cannot submit receipts for a future month"
 *     and the message blamed the student.
 *   - The previous month was dropped by an index slice rather than a date test, so
 *     a student who missed the September deadline could not pick September in
 *     October even though the server would accept it.
 *
 * The server is the authority (lib/period.ts): it accepts the current or previous
 * month, inside the cohort's dates, and nothing else. So the list now always
 * contains those two months, flagged `isSubmittable`, plus the program months for
 * context. Anything not submittable is shown disabled with the reason, instead of
 * being offered and then rejected.
 */
function buildMonthOptions(): MonthOption[] {
  const now = new Date()
  const deadlineDay = 15
  const curYear = now.getUTCFullYear()
  const curMonth = now.getUTCMonth()

  const prev = new Date(Date.UTC(curYear, curMonth - 1, 1))
  const submittable = new Set([
    monthValue(curYear, curMonth),
    monthValue(prev.getUTCFullYear(), prev.getUTCMonth())
  ])

  const seen = new Set<string>()
  const opts: MonthOption[] = []

  const push = (year: number, month0: number) => {
    const value = monthValue(year, month0)
    if (seen.has(value)) return
    seen.add(value)

    const isCurrent = year === curYear && month0 === curMonth
    const isSubmittable = submittable.has(value)
    const monthStartUtc = Date.UTC(year, month0, 1)
    const thisMonthUtc = Date.UTC(curYear, curMonth, 1)

    let tag: string | undefined
    if (!isSubmittable) tag = monthStartUtc > thisMonthUtc ? 'not open yet' : 'closed'
    else if (isCurrent && now.getUTCDate() > deadlineDay) tag = 'past deadline'
    else if (monthStartUtc < thisMonthUtc) tag = 'late, still accepted'

    opts.push({
      value,
      label: new Date(monthStartUtc).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      tag,
      isCurrent,
      isSubmittable
    })
  }

  // Always offer what the server will actually take, even outside the program
  // months. If it is outside the cohort's dates the server says so precisely.
  push(prev.getUTCFullYear(), prev.getUTCMonth())
  push(curYear, curMonth)
  for (let i = 0; i < PROGRAM_MONTHS; i++) {
    push(
      PROGRAM_START_YEAR + Math.floor((PROGRAM_START_MONTH + i) / 12),
      (PROGRAM_START_MONTH + i) % 12
    )
  }

  opts.sort((a, b) => a.value.localeCompare(b.value))
  return opts
}

export default function UploadPage() {
  const monthOptions = buildMonthOptions()
  // Default to a month the server will accept, so the first submit cannot fail on
  // the selector's own default. `.slice(1)` used to drop the previous month by
  // index, which is why September could not be chosen in October.
  const currentMonth =
    monthOptions.find(o => o.isCurrent && o.isSubmittable) ??
    monthOptions.find(o => o.isSubmittable) ??
    monthOptions[0]
  const pastMonths = monthOptions.filter(o => o.value !== currentMonth.value)
  const [selectedPeriod, setSelectedPeriod] = useState(currentMonth.value)
  const [showPastMonths, setShowPastMonths] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const isLate = selectedPeriod !== currentMonth.value

  // Column names must match the receipts table exactly: it is `uploaded_at`, not
  // `created_at`, and `bud_light_total_incl_tax`, not `bl_total`. Selecting the
  // wrong names made the whole query error, and because only `data` was
  // destructured the student simply saw an empty receipt list forever.
  type PastReceipt = { id: string; uploaded_at: string; storage_mime: string; storage_bytes: number; status: string; bud_light_total_incl_tax: number | null }
  const [pastReceipts, setPastReceipts] = useState<PastReceipt[]>([])
  const [loadingReceipts, setLoadingReceipts] = useState(false)

  const loadReceipts = useCallback(async (period: string) => {
    setLoadingReceipts(true)
    const sb = browserClient()
    const { data: userRes } = await sb.auth.getUser()
    if (!userRes.user) { setLoadingReceipts(false); return }
    const bamId = await resolveBamId(sb, userRes.user)
    if (!bamId) { setLoadingReceipts(false); return }
    const { data } = await sb.from('receipts')
      .select('id, uploaded_at, storage_mime, storage_bytes, status, bud_light_total_incl_tax')
      .eq('bam_id', bamId)
      .eq('period', period)
      .order('uploaded_at', { ascending: false })
    setPastReceipts(data ?? [])
    setLoadingReceipts(false)
  }, [])

  useEffect(() => { loadReceipts(selectedPeriod) }, [selectedPeriod, loadReceipts])

  // Poll while any receipt is still pending (OCR in progress)
  useEffect(() => {
    const hasPending = pastReceipts.some(r => r.status === 'pending' || r.status === 'processing')
    if (!hasPending) return
    const timer = setInterval(() => loadReceipts(selectedPeriod), 5000)
    return () => clearInterval(timer)
  }, [pastReceipts, selectedPeriod, loadReceipts])

  function validateAndSet(picked: File[]) {
    setErr(null)
    for (const f of picked) {
      if (!ALLOWED_MIME.includes(f.type)) return setErr(`${f.name}: unsupported file type (only JPG, PNG, WebP, PDF)`)
      if (f.size > MAX_MB * 1024 * 1024) return setErr(`${f.name}: over ${MAX_MB} MB`)
    }
    setFiles(prev => [...prev, ...picked])
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    validateAndSet(Array.from(e.target.files ?? []))
    if (inputRef.current) inputRef.current.value = ''
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    validateAndSet(Array.from(e.dataTransfer.files))
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  async function submit() {
    setBusy(true); setErr(null); setMsg(null)
    const isDev = process.env.NODE_ENV === 'development'
    const sb = browserClient()
    const { data: userRes } = await sb.auth.getUser()

    let bamId: string
    if (isDev && !userRes.user) {
      bamId = '00000000-0000-0000-0000-000000000000'
    } else {
      if (!userRes.user) { setErr('Please log in.'); setBusy(false); return }
      bamId = (await resolveBamId(sb, userRes.user)) ?? ''
      if (!bamId) { setErr('Account not activated. Contact your program manager.'); setBusy(false); return }
    }

    const period = selectedPeriod
    for (const f of files) {
      const buf = await f.arrayBuffer()
      const bytes = new Uint8Array(buf)
      const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
      const sha256 = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('')

      const form = new FormData()
      form.append('file', f)
      form.append('bam_id', bamId)
      form.append('sha256', sha256)
      form.append('period', period)

      const res = await fetch('/api/portal/upload', { method: 'POST', body: form })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) {
        setErr(`Upload failed: ${json.message || res.statusText}`)
        setBusy(false)
        return
      }
    }

    setBusy(false)
    setFiles([])
    setMsg(`${files.length} receipt${files.length > 1 ? 's' : ''} submitted. You'll hear from your program manager if we need anything.`)
    loadReceipts(selectedPeriod)
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">Upload receipts</span></div>
      </div>

      <div style={{ maxWidth: 680 }}>
        <h1>Upload this month&rsquo;s Bud Light receipts</h1>
        <p className="subtle">Multiple receipts OK. JPG, PNG, WebP, or PDF. Under {MAX_MB}&nbsp;MB each.</p>

        <div className="surface stack" style={{ marginTop: 20 }}>
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', background: 'var(--bl-fog)', borderRadius: 8
            }}>
              <div>
                <span className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Submitting for
                </span>
                <div style={{ fontWeight: 700, fontSize: 15, marginTop: 1 }}>
                  {monthOptions.find(o => o.value === selectedPeriod)?.label}
                  {isLate && <span style={{ color: 'var(--amber)', fontSize: 12, fontWeight: 500, marginLeft: 8 }}>late</span>}
                </div>
              </div>
              {!showPastMonths ? (
                <button
                  type="button"
                  style={{
                    fontSize: 12, padding: '6px 14px',
                    background: 'var(--bl-blue)', color: '#fff',
                    border: 'none', borderRadius: 6, cursor: 'pointer',
                    fontWeight: 600
                  }}
                  onClick={() => setShowPastMonths(true)}
                >
                  Different month?
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: '6px 14px' }}
                  onClick={() => { setSelectedPeriod(currentMonth.value); setShowPastMonths(false) }}
                >
                  Back to {currentMonth.label.split(' ')[0]}
                </button>
              )}
            </div>
            {showPastMonths && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {/* A month the server will not accept is disabled with the reason,
                    rather than offered and then rejected after the upload. */}
                {pastMonths.map(o => (
                  <button
                    key={o.value}
                    type="button"
                    disabled={!o.isSubmittable}
                    title={o.isSubmittable ? undefined : (o.tag === 'not open yet' ? 'This month has not opened yet' : 'This month is closed')}
                    className={selectedPeriod === o.value ? 'btn-navy' : 'btn-ghost'}
                    style={{
                      fontSize: 12, padding: '6px 14px',
                      opacity: o.isSubmittable ? 1 : 0.4,
                      cursor: o.isSubmittable ? 'pointer' : 'not-allowed'
                    }}
                    onClick={() => { if (o.isSubmittable) setSelectedPeriod(o.value) }}
                  >
                    {o.label.split(' ')[0]}
                  </button>
                ))}
              </div>
            )}
            {isLate && (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Late submissions are accepted but may delay your reimbursement.
              </p>
            )}
          </div>

          <div
            className={`drop-zone${dragging ? ' drop-zone--active' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ALLOWED_MIME.join(',')}
              onChange={onFileChange}
              style={{ display: 'none' }}
            />
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--bl-blue)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p style={{ margin: '8px 0 0', fontWeight: 600, color: 'var(--bl-navy)' }}>
              Drop receipts here or <span style={{ color: 'var(--bl-blue)', textDecoration: 'underline' }}>browse</span>
            </p>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
              JPG, PNG, WebP, or PDF. Up to {MAX_MB} MB each
            </p>
          </div>

          {files.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {files.map((f, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', background: 'var(--bl-fog)', borderRadius: 8, fontSize: 13
                }}>
                  <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span className="muted">{(f.size / 1024).toFixed(0)} KB</span>
                  <button
                    className="btn-ghost"
                    style={{ padding: '2px 8px', fontSize: 11, color: 'var(--red)' }}
                    onClick={(e) => { e.stopPropagation(); removeFile(i) }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={submit}
            disabled={busy || files.length === 0}
            style={{
              padding: '14px 24px', fontSize: 15, fontWeight: 700,
              ...(files.length > 0 ? { background: 'var(--bl-blue)', transform: 'scale(1)' } : {})
            }}
          >
            {busy ? 'Submitting…' : files.length > 0
              ? `Submit ${files.length} receipt${files.length === 1 ? '' : 's'}`
              : 'Select receipts to submit'}
          </button>
        </div>

        {err && <p style={{ color: '#A31212', marginTop: 16 }}>{err}</p>}
        {msg && <p style={{ color: 'var(--green)', marginTop: 16 }}>{msg}</p>}

        {/* Submitted receipts for this month */}
        {pastReceipts.length > 0 && (
          <div className="surface" style={{ marginTop: 20 }}>
            <div className="surface-header">
              <span className="surface-title">Your receipts this month ({pastReceipts.length})</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pastReceipts.map(r => {
                const statusColor: Record<string, string> = {
                  pending: 'var(--amber)', processing: 'var(--amber)',
                  approved: 'var(--green)', auto_pass: 'var(--green)',
                  review: '#D97706', rejected: '#A31212', ocr_failed: '#A31212'
                }
                const statusLabel: Record<string, string> = {
                  pending: 'Processing', processing: 'Processing',
                  approved: 'Approved', auto_pass: 'Approved',
                  review: 'Under review', rejected: 'Not accepted', ocr_failed: 'Processing error'
                }
                return (
                  <div key={r.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 12px', background: 'var(--bl-fog)', borderRadius: 8, fontSize: 13
                  }}>
                    <span style={{ fontSize: 16, flexShrink: 0 }}>{r.storage_mime === 'application/pdf' ? '\u{1F4C4}' : '\u{1F4F8}'}</span>
                    <span className="muted" style={{ flex: 1 }}>
                      {new Date(r.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                    {r.bud_light_total_incl_tax != null && <span style={{ fontWeight: 600, fontSize: 12 }}>${r.bud_light_total_incl_tax.toFixed(2)}</span>}
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                      background: (statusColor[r.status] ?? 'var(--midgray)') + '1a',
                      color: statusColor[r.status] ?? 'var(--midgray)'
                    }}>
                      {statusLabel[r.status] ?? r.status}
                    </span>
                  </div>
                )
              })}
            </div>
            {pastReceipts.some(r => r.bud_light_total_incl_tax != null) && (
              <div style={{ marginTop: 10, padding: '8px 12px', display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600 }}>
                <span>BL total this month</span>
                <span style={{ color: pastReceipts.reduce((s, r) => s + (r.bud_light_total_incl_tax ?? 0), 0) >= 150 ? 'var(--green)' : 'var(--amber)' }}>
                  ${pastReceipts.reduce((s, r) => s + (r.bud_light_total_incl_tax ?? 0), 0).toFixed(2)} / $150
                </span>
              </div>
            )}
          </div>
        )}
        {loadingReceipts && pastReceipts.length === 0 && <p className="muted" style={{ marginTop: 16, fontSize: 13 }}>Loading your receipts...</p>}

        <div className="surface" style={{ marginTop: 20 }}>
          <div className="surface-header"><span className="surface-title">Receipt checklist</span></div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { icon: '🏷️', title: 'Label by month', desc: 'Name your file with the month it\'s for (e.g. "October receipt").' },
              { icon: '🍺', title: 'Bud Light products only', desc: 'Only Bud Light purchases count toward your $150 reimbursement.' },
              { icon: '✨', title: 'Mixed receipt? Highlight BL items', desc: 'If your receipt has non-BL items, circle or highlight the Bud Light products before uploading.' },
              { icon: '📸', title: 'Clear, readable photos', desc: 'Make sure the store name, date, items, and total are all legible. No blurry or cropped images.' },
              { icon: '💰', title: 'Purchase $150 worth per month', desc: 'Aim for $150 (tax included). Under ~$140 may be flagged for review.' },
              { icon: '📅', title: 'Submit by the 15th', desc: 'Receipts are due by the 15th of each month. Late submissions may delay reimbursement.' },
            ].map((item, i) => (
              <li key={i} style={{
                display: 'flex', gap: 12, alignItems: 'flex-start',
                padding: '10px 14px', background: 'var(--bl-fog)', borderRadius: 8
              }}>
                <span style={{ fontSize: 20, lineHeight: '24px', flexShrink: 0 }}>{item.icon}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--bl-navy)' }}>{item.title}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{item.desc}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Steps confirmed in 8/4 meeting with Robin/Nathan */}
        <div className="surface" style={{ marginTop: 20 }}>
          <div className="surface-header"><span className="surface-title">What happens next</span></div>
          <ol className="stack subtle" style={{ margin: 0, paddingLeft: 20 }}>
            <li>Our AI reads your receipt and pulls the Bud Light items.</li>
            <li>If everything&rsquo;s clear, it&rsquo;s auto-approved. Anything unclear goes to your program manager for review.</li>
            <li>On the 16th, your monthly invoice generates automatically with your reimbursement + salary. You&rsquo;ll get a copy by email.</li>
          </ol>
        </div>
      </div>
    </>
  )
}
