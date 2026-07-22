'use client'
import { useRef, useState } from 'react'
import { browserClient } from '@/lib/supabase-browser'

const MAX_MB = 10
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

function buildMonthOptions(): { value: string; label: string; tag?: string }[] {
  const now = new Date()
  const isDev = process.env.NODE_ENV === 'development'
  const deadlineDay = 15
  const opts: { value: string; label: string; tag?: string }[] = []
  const futureMonths = isDev ? 3 : 0
  for (let offset = futureMonths; offset >= -3; offset--) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
    const value = d.toISOString().slice(0, 10)
    const label = d.toLocaleString('en-US', { month: 'long', year: 'numeric' })
    let tag: string | undefined
    if (offset > 0) tag = 'dev'
    else if (offset < 0 || (offset === 0 && now.getDate() > deadlineDay)) tag = 'late'
    opts.push({ value, label, tag })
  }
  return opts
}

export default function UploadPage() {
  const monthOptions = buildMonthOptions()
  const [selectedPeriod, setSelectedPeriod] = useState(monthOptions[0].value)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

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
      bamId = (userRes.user.user_metadata as { bam_id?: string }).bam_id ?? ''
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
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">Upload receipts</span></div>
      </div>

      <div style={{ maxWidth: 640 }}>
        <p className="eyebrow">SUBMIT RECEIPTS</p>
        <h1>Upload this month&rsquo;s Bud Light receipts</h1>
        <p className="subtle">Multiple receipts OK. JPG, PNG, WebP, or PDF. Under {MAX_MB}&nbsp;MB each.</p>

        <div className="surface stack" style={{ marginTop: 20 }}>
          <div className="field">
            <label>Receipt month</label>
            <select value={selectedPeriod} onChange={e => setSelectedPeriod(e.target.value)}>
              {monthOptions.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}{o.tag ? ` (${o.tag})` : ''}
                </option>
              ))}
            </select>
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
              JPG, PNG, WebP, or PDF — up to {MAX_MB} MB each
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

          <button onClick={submit} disabled={busy || files.length === 0}>
            {busy ? 'Submitting…' : `Submit ${files.length || ''} receipt${files.length === 1 ? '' : 's'}`}
          </button>
        </div>

        {err && <p style={{ color: '#A31212', marginTop: 16 }}>{err}</p>}
        {msg && <p style={{ color: 'var(--green)', marginTop: 16 }}>{msg}</p>}

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
