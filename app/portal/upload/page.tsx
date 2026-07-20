'use client'
import { useState } from 'react'
import { browserClient } from '@/lib/supabase-browser'

const MAX_MB = 10
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

export default function UploadPage() {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setErr(null)
    const picked = Array.from(e.target.files ?? [])
    for (const f of picked) {
      if (!ALLOWED_MIME.includes(f.type))     return setErr(`${f.name}: unsupported file type (only JPG, PNG, WebP, PDF)`)
      if (f.size > MAX_MB * 1024 * 1024)      return setErr(`${f.name}: over ${MAX_MB} MB`)
    }
    setFiles(picked)
  }

  async function submit() {
    setBusy(true); setErr(null); setMsg(null)
    const sb = browserClient()
    const { data: userRes } = await sb.auth.getUser()
    if (!userRes.user) { setErr('Please log in.'); setBusy(false); return }

    // fetch bam_id from user metadata (set at onboarding)
    const bamId = (userRes.user.user_metadata as { bam_id?: string }).bam_id
    if (!bamId) { setErr('Account not activated. Contact your program manager.'); setBusy(false); return }

    const period = new Date().toISOString().slice(0, 7) + '-01'   // first-of-month
    for (const f of files) {
      const buf = await f.arrayBuffer()
      const bytes = new Uint8Array(buf)
      // sha256 client-side
      const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
      const sha256 = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('')

      const ext = f.name.split('.').pop() || 'bin'
      const storageKey = `${bamId}/${period}/${sha256}.${ext}`

      const { error: upErr } = await sb.storage.from('receipts').upload(storageKey, f, { contentType: f.type, upsert: false })
      if (upErr && !/duplicate/i.test(upErr.message)) { setErr(`Upload failed: ${upErr.message}`); setBusy(false); return }

      const { error: insErr } = await sb.from('receipts').insert({
        bam_id: bamId, period, storage_key: storageKey, storage_mime: f.type, storage_bytes: f.size, sha256
      })
      if (insErr) { setErr(`Record failed: ${insErr.message}`); setBusy(false); return }
    }

    setBusy(false)
    setFiles([])
    setMsg(`${files.length} receipt${files.length > 1 ? 's' : ''} submitted. You&rsquo;ll hear from Robin if we need anything.`)
  }

  return (
    <main className="container" style={{ maxWidth: 600 }}>
      <p className="eyebrow">SUBMIT RECEIPTS</p>
      <h1>Upload this month&rsquo;s Bud Light receipts</h1>
      <p className="subtle">Multiple receipts OK. JPG, PNG, WebP, or PDF. Under {MAX_MB}&nbsp;MB each.</p>

      <div className="hero-card stack" style={{ marginTop: 24 }}>
        <input type="file" multiple accept={ALLOWED_MIME.join(',')} onChange={onFileChange} />
        {files.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {files.map((f, i) => <li key={i}>{f.name} <span className="muted">({(f.size / 1024).toFixed(0)} KB)</span></li>)}
          </ul>
        )}
        <button onClick={submit} disabled={busy || files.length === 0}>
          {busy ? 'Submitting…' : `Submit ${files.length || ''} receipt${files.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {err && <p style={{ color: '#A31212', marginTop: 16 }}>{err}</p>}
      {msg && <p style={{ color: 'var(--seagreen)', marginTop: 16 }}>{msg}</p>}

      <h2>What happens next</h2>
      <ol className="stack subtle">
        <li>Our AI reads your receipt and pulls the Bud Light items.</li>
        <li>If everything&rsquo;s clear, it&rsquo;s auto-approved. Anything unclear goes to Robin for review.</li>
        <li>On the 16th, your monthly invoice generates automatically with your reimbursement + salary. You&rsquo;ll get a copy by email.</li>
      </ol>
    </main>
  )
}
