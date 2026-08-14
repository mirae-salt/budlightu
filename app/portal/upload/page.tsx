'use client'
import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { browserClient } from '@/lib/supabase-browser'
import { resolveBamId } from '@/lib/portal-bam'
import { buildMonthOptions, type CohortWindow } from '@/lib/upload-months'
import Link from 'next/link'

const MAX_MB = 10
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

export default function UploadPage() {
  // A BAM can read their own cohort (policy cohorts_bam_read_own), so the selector
  // can enforce the same window the server does instead of guessing.
  const [cohortWindow, setCohortWindow] = useState<CohortWindow | null>(null)
  const [isTestBam, setIsTestBam] = useState(false)

  const monthOptions = useMemo(() => buildMonthOptions(cohortWindow, isTestBam), [cohortWindow, isTestBam])
  // Default to a month the server will accept, so the first submit cannot fail on
  // the selector's own default. `.slice(1)` used to drop the previous month by
  // index, which is why September could not be chosen in October.
  const currentMonth =
    monthOptions.find(o => o.isCurrent && o.isSubmittable) ??
    monthOptions.find(o => o.isSubmittable) ??
    monthOptions[0]
  const pastMonths = monthOptions.filter(o => o.value !== currentMonth.value)
  /**
   * Is there any OTHER month they could actually pick?
   *
   * Almost always no. buildMonthOptions makes exactly one month submittable, the current one and
   * only before its deadline, so "Different month?" opened a list of nine greyed-out buttons and
   * answered nothing. The button is only offered when this is true; otherwise the rule is stated
   * once, in a sentence, with somewhere to go if that is a problem.
   */
  const hasOtherSubmittable = pastMonths.some(o => o.isSubmittable)
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

  // Load the cohort window and the test flag so the selector enforces exactly what
  // lib/period.ts enforces. Reading these is permitted: policy cohorts_bam_read_own
  // and the BAM's own bams row. Failure leaves the selector on the date rule alone,
  // which is the conservative side: the server still has the last word.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const sb = browserClient()
      const { data: userRes } = await sb.auth.getUser()
      if (!userRes.user) return
      const bamId = await resolveBamId(sb, userRes.user)
      if (!bamId) return

      const { data: bam, error } = await sb.from('bams')
        .select('is_test, cohort_id, cohorts(start_date, end_date)')
        .eq('id', bamId)
        .maybeSingle()
      if (cancelled || error || !bam) return

      if (bam.is_test === true) setIsTestBam(true)

      // supabase-js types an embedded to-one relation as an array even though it
      // returns an object, so accept either shape rather than casting blindly.
      type CohortDates = { start_date: string | null; end_date: string | null }
      const embedded = bam.cohorts as unknown as CohortDates | CohortDates[] | null
      const c = Array.isArray(embedded) ? embedded[0] ?? null : embedded
      if (c?.start_date && c?.end_date) {
        setCohortWindow({
          startMonth: `${c.start_date.slice(0, 7)}-01`,
          endMonth: `${c.end_date.slice(0, 7)}-01`
        })
      }
    })()
    return () => { cancelled = true }
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
                {/* The month name alone is misread: "September" looks like Sept 1-30,
                    but with receipts closing on the 15th and no rollover the real
                    window is the 16th to the 15th. */}
                {monthOptions.find(o => o.value === selectedPeriod)?.windowLabel && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    covers purchases {monthOptions.find(o => o.value === selectedPeriod)?.windowLabel}
                  </div>
                )}
              </div>
              {showPastMonths ? (
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: '6px 14px' }}
                  onClick={() => { setSelectedPeriod(currentMonth.value); setShowPastMonths(false) }}
                >
                  Back to {currentMonth.shortLabel}
                </button>
              ) : hasOtherSubmittable ? (
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
              ) : null}
            </div>

            {/*
              OUTSIDE the row above. It started inside it, where the "Different month?" button used to
              sit: a short button fits in a flex row, a two-line sentence does not, and it squeezed the
              label column until "Submitting for" broke across two lines.

              Shown only when there is genuinely no other month to pick, which is the normal case.
              buildMonthOptions makes exactly one month submittable, so offering a button that opens
              nine greyed-out ones answered nothing. Says the rule once and gives somewhere to go,
              because "you cannot" with no next step is a dead end that becomes Robin's inbox.
            */}
            {!showPastMonths && !hasOtherSubmittable && (
              <p className="muted" style={{ fontSize: 12, lineHeight: 1.6, margin: '8px 0 0' }}>
                Receipts are due by the 15th, so this is the only month you can submit for.{' '}
                <Link href="/portal/support">Ask about another month</Link>
              </p>
            )}

            {showPastMonths && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {/* A month the server will not accept is disabled with the reason,
                    rather than offered and then rejected after the upload. */}
                {pastMonths.map(o => (
                  <button
                    key={o.value}
                    type="button"
                    disabled={!o.isSubmittable}
                    title={
                      o.isSubmittable
                        ? (o.windowLabel ? `Covers purchases ${o.windowLabel}` : undefined)
                        : (o.tag ? `Not available: ${o.tag}` : 'This month is closed')
                    }
                    className={selectedPeriod === o.value ? 'btn-navy' : 'btn-ghost'}
                    style={{
                      fontSize: 12, padding: '6px 14px',
                      opacity: o.isSubmittable ? 1 : 0.4,
                      cursor: o.isSubmittable ? 'pointer' : 'not-allowed'
                    }}
                    onClick={() => { if (o.isSubmittable) setSelectedPeriod(o.value) }}
                  >
                    {o.shortLabel}
                  </button>
                ))}
              </div>
            )}
            {isLate && (
              <p className="muted" style={{ fontSize: 12, marginTop: 6, color: 'var(--amber)' }}>
                {/* This used to read "Late submissions are accepted but may delay your
                    reimbursement", which stopped being true: a closed month is refused
                    now, because accepting it meant storing a receipt that nothing would
                    ever look at. */}
                Receipts close on the 15th. After that the month is closed and this one
                will not be counted, so send it in before the deadline.
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

        {err && (
          <div style={{ color: '#A31212', marginTop: 16 }}>
            <p style={{ margin: 0 }}>{err}</p>
            {/* The server tells a student to ask on the Support page when a month is
                closed. Telling them where to go without taking them there just moves
                the dead end one step along, so the link is rendered here. */}
            {err.includes('Support page') && (
              <p style={{ margin: '6px 0 0', fontSize: 13 }}>
                <Link href="/portal/support" style={{ color: 'var(--bl-blue)', fontWeight: 600 }}>
                  Ask about this on the Support page
                </Link>
              </p>
            )}
          </div>
        )}
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
              /*
               * "Label by month, name your file..." REMOVED 2026-08-14 per Robin, from the
               * BL Campus x AI Final Connect meeting: a BAM uploading a photo straight from
               * their camera roll on a phone cannot rename the file first, so an instruction
               * that assumes they can is an instruction they cannot follow. The storage key
               * was never derived from the filename anyway (it's {bam_id}/{period}/{sha256}),
               * so nothing downstream depended on this and nothing changes except that the
               * checklist stops asking for something students could not do.
               */
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
