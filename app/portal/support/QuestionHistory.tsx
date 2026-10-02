/**
 * The BAM's own questions and answers, in the portal.
 *
 * The Support page took a question and then showed nothing back: no history, no answer, no evidence
 * it had been received. The reply arrived by email and that was the only copy, so a student who
 * deleted the mail, or who asked twice because they were not sure the first one landed, had nowhere
 * to look.
 *
 * Renders nothing until it knows. An empty list here is a statement, and "we never got your
 * question" is the one wrong thing this component can say by accident, so a failed read says so
 * instead of showing zero.
 *
 * One question and one answer per card, because that is what `portal_questions` stores. A real
 * back-and-forth needs a child table; see HANDOFF-2026-08-13.md section 1.3.
 */
'use client'

import { useEffect, useState } from 'react'
import { AttachmentPicker, AttachmentView, type PickedAttachment } from '@/app/_components/SupportAttachment'

type Message = {
  id: string; author: 'bam' | 'admin'; body: string; created_at: string
  attachment_key?: string | null
  attachment_mime?: string | null
  attachment_name?: string | null
  attachment_bytes?: number | null
}

type Row = {
  id: string
  question: string
  answer: string | null
  answered_at: string | null
  submitted_at: string
  /** Every message, oldest first. Migration 0027; the server sorts. */
  messages?: Message[]
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  })
}

export function QuestionHistory({
  refreshKey,
  onCount
}: {
  refreshKey?: number
  /** Reports how many rows loaded, so the page can open the composer when there are none. */
  onCount?: (n: number) => void
}) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replyFile, setReplyFile] = useState<PickedAttachment | null>(null)
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  /** Bumped locally so a sent follow-up appears without waiting for the parent. */
  const [localKey, setLocalKey] = useState(0)

  async function sendFollowUp(questionId: string) {
    setBusy(true)
    setSendError(null)
    try {
      const res = await fetch('/api/portal/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: questionId, body: replyText, attachment: replyFile })
      })
      const j = await res.json()
      if (!res.ok || !j?.ok) {
        setSendError(j?.message ?? 'That did not send.')
        return
      }
      setReplyingTo(null)
      setReplyText('')
      setReplyFile(null)
      // Refetch rather than pushing the local message in: the thread also reopened server-side, and
      // the badge has to reflect that.
      setLocalKey(k => k + 1)
    } catch (e) {
      setSendError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    fetch('/api/portal/questions')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        if (j?.ok) {
          const list: Row[] = Array.isArray(j.questions) ? j.questions : []
          setRows(list)
          onCount?.(list.length)
        } else {
          setError(j?.message ?? 'Could not load your questions.')
        }
      })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [refreshKey, localKey])

  if (error) {
    return (
      <div className="surface" style={{ marginTop: 24, padding: 20 }}>
        <p style={{ fontSize: 13, color: '#991b1b', margin: 0, lineHeight: 1.6 }}>
          We could not load your past questions: {error}. This does not mean they were lost.
        </p>
      </div>
    )
  }

  // Still loading, or nothing asked yet. The page shows the composer in the empty case, so a box
  // saying "no questions" would just be in the way.
  if (rows === null || rows.length === 0) return null

  const waiting = rows.filter(r => !r.answered_at).length

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        gap: 12, marginBottom: 12, flexWrap: 'wrap'
      }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
          {rows.length} question{rows.length === 1 ? '' : 's'}
        </h2>
        {waiting > 0 && (
          <span className="subtle" style={{ fontSize: 12 }}>
            {waiting} waiting for a reply
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.map(r => (
          <div
            key={r.id}
            className={`support-thread${r.answered_at ? ' is-answered' : ' is-waiting'}`}
          >
            {/* A status word, not just a colour. Colour alone is not a status anyone can read out
                loud, and it is invisible to a colourblind student. */}
            <div className="support-thread-heading">
              <span style={{
                display: 'inline-block', padding: '2px 9px', borderRadius: 999,
                fontSize: 11, fontWeight: 700, letterSpacing: '0.02em',
                background: r.answered_at ? '#E9F5EC' : '#FFF2D8',
                color: r.answered_at ? '#176442' : '#8A5300'
              }}>
                {r.answered_at ? 'Answered' : 'Waiting for a reply'}
              </span>
              <span className="subtle" style={{ fontSize: 12 }}>{when(r.submitted_at)}</span>
            </div>

            {/*
              THE THREAD. This used to be one question with one answer under it, which meant a
              follow-up appeared as a brand new unrelated card and a second reply overwrote the first.
              Messages carry their own author and time (migration 0027), so a conversation reads as one.

              Falls back to question/answer for a row whose messages could not be read, rather than
              rendering an empty card.
            */}
            {(r.messages && r.messages.length > 0
              ? r.messages
              : ([
                  { id: 'q', author: 'bam' as const, body: r.question, created_at: r.submitted_at },
                  ...(r.answer
                    ? [{ id: 'a', author: 'admin' as const, body: r.answer, created_at: r.answered_at ?? r.submitted_at }]
                    : [])
                ])
            ).map(m => (
              <div
                key={m.id}
                className={`support-message${m.author === 'admin' ? ' is-team' : ''}`}
              >
                <div className="support-message-meta">
                  <strong>{m.author === 'admin' ? 'Program team' : 'You'}</strong>
                  <span>{when(m.created_at)}</span>
                </div>
                <div className="support-message-body">
                  {m.body}
                </div>
                {m.attachment_key && (
                  <AttachmentView
                    attachmentKey={m.attachment_key}
                    mime={m.attachment_mime ?? null}
                    name={m.attachment_name}
                    bytes={m.attachment_bytes}
                  />
                )}
              </div>
            ))}

            {/* Follow-up. Sending reopens the thread, so it goes back into the admin's Open list.
                Without this the student's only option was to start a second, unconnected question. */}
            {replyingTo === r.id ? (
              <div style={{ marginTop: 12 }}>
                <textarea
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  rows={3}
                  autoFocus
                  placeholder="Add to this conversation"
                  style={{
                    width: '100%', boxSizing: 'border-box', fontSize: 14, fontFamily: 'inherit',
                    padding: '10px 12px', border: '1px solid rgba(0,0,0,0.15)', borderRadius: 8,
                    resize: 'vertical'
                  }}
                />
                <AttachmentPicker questionId={r.id} value={replyFile} onChange={setReplyFile} disabled={busy} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    /* A photo on its own is a message. Requiring words as well would tell
                       somebody to describe the screenshot they are already sending. */
                    disabled={busy || (replyText.trim().length < 2 && !replyFile)}
                    onClick={() => void sendFollowUp(r.id)}
                  >
                    {busy ? 'Sending...' : 'Send'}
                  </button>
                  <button className="btn-ghost" disabled={busy} onClick={() => { setReplyingTo(null); setReplyText(''); setReplyFile(null) }}>
                    Cancel
                  </button>
                  {sendError && <span style={{ fontSize: 13, color: '#991b1b' }}>{sendError}</span>}
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setReplyingTo(r.id); setReplyText(''); setSendError(null) }}
                style={{
                  marginTop: 12, background: 'none', border: 'none', padding: '4px 0',
                  fontSize: 13, fontWeight: 600, color: 'var(--bl-blue, #0073cf)', cursor: 'pointer'
                }}
              >
                Reply
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
