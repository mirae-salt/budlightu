'use client'
/**
 * Attaching a file to a support message, and showing one.
 *
 * Theo Cliche, 2026-09-04, mid-thread about a receipt that would not upload: "It also does
 * not allow me to send you pictures on this log."
 *
 * THE FILE DOES NOT GO THROUGH OUR API
 *
 * Mirae, 2026-09-08: "근데 여기도 파일제한 있으면 먼소영". If the attachment were posted
 * to a route the way the receipt was, it would hit the same 4.5 MB platform ceiling that
 * caused the problem being reported, and the file most worth sending is the one too big to
 * send. So: ask our route for a signed upload URL, PUT the file straight to Supabase
 * Storage, and hand the message only the key. Nothing but JSON crosses the function.
 */
import { useRef, useState } from 'react'
import { browserClient } from '@/lib/supabase-browser'
import {
  SUPPORT_ALLOWED_MIME,
  SUPPORT_MAX_LABEL,
  attachmentProblem,
  isViewableImage
} from '@/lib/support-attachment'

export type PickedAttachment = { key: string; mime: string; bytes: number; name: string }

export function attachmentUrl(key: string): string {
  return `/api/portal/support/attachment?key=${encodeURIComponent(key)}`
}

function prettySize(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0)
  if (!Number.isFinite(n) || n <= 0) return ''
  return n < 1_000_000 ? `${Math.round(n / 1000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`
}

/**
 * Pick one file and put it in Storage. Reports the key upward once it is really there.
 *
 * `questionId` is the thread it belongs to, or undefined on the new-question form, where
 * the thread does not exist yet. Either way the object lands under the student's own
 * prefix, which is what the serving route checks.
 */
export function AttachmentPicker({
  questionId,
  value,
  onChange,
  disabled
}: {
  questionId?: string
  value: PickedAttachment | null
  onChange: (a: PickedAttachment | null) => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function pick(file: File | undefined) {
    if (!file) return
    setErr(null)

    // Said before the wait, not after it. These are a courtesy; the bucket enforces the
    // same limits server-side, because our code never sees the bytes.
    const problem = attachmentProblem(file)
    if (problem) { setErr(problem); return }

    setBusy(true)
    try {
      const signRes = await fetch('/api/portal/support/attachment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: questionId ?? '', mime: file.type })
      })
      const signed = await signRes.json().catch(() => ({}))
      if (!signRes.ok || !signed?.ok) {
        setErr(signed?.message ?? 'We could not start that upload. Please try again.')
        return
      }

      const { error } = await browserClient()
        .storage.from(signed.bucket)
        .uploadToSignedUrl(signed.key, signed.token, file, { contentType: file.type })
      if (error) {
        // Storage refuses on its own limits too, and its message is the accurate one.
        setErr(`That did not upload: ${error.message}`)
        return
      }

      onChange({ key: signed.key, mime: file.type, bytes: file.size, name: file.name })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  if (value) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
        padding: '8px 10px', border: '1px solid var(--stone, #d8d8d8)', borderRadius: 8,
        background: 'var(--bl-fog, #f7f7f8)', fontSize: 13
      }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value.name} <span className="subtle">{prettySize(value.bytes)}</span>
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={disabled}
          style={{
            border: 'none', background: 'none', cursor: 'pointer',
            color: 'var(--midgray, #6b7280)', fontSize: 13, textDecoration: 'underline'
          }}
        >
          Remove
        </button>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 8 }}>
      <input
        ref={inputRef}
        type="file"
        accept={SUPPORT_ALLOWED_MIME.join(',')}
        onChange={e => pick(e.target.files?.[0])}
        disabled={disabled || busy}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || busy}
        style={{
          border: '1px solid var(--stone, #d8d8d8)', borderRadius: 8, background: '#fff',
          padding: '6px 12px', fontSize: 13, cursor: busy ? 'default' : 'pointer',
          color: 'var(--midgray, #6b7280)'
        }}
      >
        {busy ? 'Uploading…' : 'Attach a photo or PDF'}
      </button>
      <span className="subtle" style={{ fontSize: 12, marginLeft: 10 }}>
        Up to {SUPPORT_MAX_LABEL}
      </span>
      {err && (
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--bl-red, #A31212)' }}>{err}</div>
      )}
    </div>
  )
}

/**
 * One attachment inside a thread.
 *
 * An image is shown, because the point of sending it was for somebody to look at it
 * without an extra click. Anything else, PDF and HEIC included, gets a link: no desktop
 * browser paints HEIC in an <img>, and a broken image icon would be a worse answer than a
 * filename.
 */
export function AttachmentView({
  attachmentKey,
  mime,
  name,
  bytes
}: {
  attachmentKey: string
  mime: string | null
  name?: string | null
  bytes?: number | null
}) {
  const href = attachmentUrl(attachmentKey)
  const label = name || 'Attachment'

  if (isViewableImage(mime)) {
    return (
      <a href={href} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 8 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={href}
          alt={label}
          style={{
            maxWidth: 260, maxHeight: 260, objectFit: 'contain', display: 'block',
            borderRadius: 8, border: '1px solid var(--stone, #d8d8d8)', background: '#fff'
          }}
        />
      </a>
    )
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 8,
        padding: '8px 12px', border: '1px solid var(--stone, #d8d8d8)', borderRadius: 8,
        background: '#fff', fontSize: 13, textDecoration: 'none', color: 'var(--bl-navy, #1a1a2e)'
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 11, color: 'var(--midgray, #6b7280)' }}>
        {(mime ?? '').includes('pdf') ? 'PDF' : 'FILE'}
      </span>
      <span>{label}</span>
      {bytes ? <span className="subtle">{prettySize(bytes)}</span> : null}
    </a>
  )
}
