'use client'
/**
 * /portal/support — the BAM's support tracker.
 *
 * WHAT THIS USED TO BE, AND WHY IT CHANGED
 * ---------------------------------------
 * A textarea and a Send button. It accepted a question, replaced itself with "thanks, your program
 * manager will reply by email within 1-2 business days", and showed nothing else ever again. So a
 * student had no way to see what they had asked, whether it had landed, or whether it had been
 * answered. Asking the same thing twice was the only reasonable response to that, and Robin got the
 * duplicates.
 *
 * It is now a list first: every question with its status, and a button to ask a new one. Mirae's
 * call, and it matches how every support inbox works, because the thing a person wants on this page
 * is almost never "compose" and almost always "what happened to the one I sent".
 *
 * The composer is one click away rather than gone: the first question somebody asks is the one where
 * the list is empty, so the empty state opens it directly.
 */
import { useState } from 'react'
import { AttachmentPicker, type PickedAttachment } from '@/app/_components/SupportAttachment'
import { AI_DISCLOSURE_COPY } from '@/lib/attestations'
import { QuestionHistory } from './QuestionHistory'

export default function SupportPage() {
  const [question, setQuestion] = useState('')
  const [file, setFile] = useState<PickedAttachment | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [justSent, setJustSent] = useState(false)
  /** Bumped after a send so the list refetches and the new question is visible immediately. */
  const [historyKey, setHistoryKey] = useState(0)
  /** null until the list has loaded. Drives the empty state without guessing. */
  const [count, setCount] = useState<number | null>(null)

  async function submit() {
    setErr(null)
    setBusy(true)
    try {
      const res = await fetch('/api/portal/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, attachment: file })
      })
      const json = await res.json()
      if (!res.ok || !json.ok) { setErr(json.message ?? 'Something went wrong'); return }
      // Straight back to the list, with the new question in it. A separate confirmation screen hid
      // the one piece of evidence worth showing: the question, now visibly received.
      setQuestion('')
      setFile(null)
      setComposing(false)
      setJustSent(true)
      setHistoryKey(k => k + 1)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Nothing asked yet: open the composer rather than showing an empty list and a button. The first
  // visit is the one where there is nothing to track.
  const showComposer = composing || count === 0

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">Support</span></div>
      </div>

      <div style={{ maxWidth: 960 }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          gap: 16, flexWrap: 'wrap'
        }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ marginBottom: 4 }}>Support</h1>
            <p className="subtle" style={{ margin: 0 }}>
              Your questions and the replies. Answers appear here and in your email.
            </p>
          </div>
          {!showComposer && (
            <button onClick={() => { setComposing(true); setJustSent(false) }} style={{ flexShrink: 0 }}>
              Ask a question
            </button>
          )}
        </div>

        {justSent && !showComposer && (
          <p style={{
            marginTop: 16, padding: '11px 14px', borderRadius: 8, fontSize: 13,
            background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)',
            color: '#166534', lineHeight: 1.6
          }}>
            Sent. It is at the top of the list below, and you will get an email when it is answered.
          </p>
        )}

        {showComposer && (
          <div className="surface stack" style={{ marginTop: 20 }}>
            <label htmlFor="support-q" className="sr-only">Your question</label>
            <p className="subtle" style={{ fontSize: 13, margin: 0, lineHeight: 1.6 }}>
              Can&rsquo;t submit this month? Not sure whether a receipt counts? Ask here.
            </p>
            <textarea
              id="support-q"
              rows={6}
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="What's going on?"
              aria-label="Your question"
            />
            {/* The thread was text only, so the one thing that would have explained Theo
                Cliche's broken upload on 2026-09-04 was the one thing he could not send. */}
            <AttachmentPicker value={file} onChange={setFile} disabled={busy} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={submit} disabled={busy || question.trim().length < 5}>
                {busy ? 'Sending...' : 'Send'}
              </button>
              {/* No Cancel when the list is empty: there is nothing to go back to. */}
              {count !== 0 && (
                <button
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => { setComposing(false); setErr(null); setFile(null) }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {err && <p style={{ color: '#A31212', marginTop: 16 }}>{err}</p>}

        <QuestionHistory refreshKey={historyKey} onCount={setCount} />

        {/*
          Shane Deen, 2026-08-27, item F: a disclosure covering PIPEDA and Quebec Law 25
          s.12.1, which gives a person the right to be told when a decision about them is
          made by automated means and to ask a human to look again. Robin confirmed on the
          same thread that 8 BAMs are at Quebec schools, so this is load-bearing rather
          than boilerplate.

          It says what this system actually does. Consent to use support messages as
          training data is asked separately at setup, because that one can be refused.
        */}
        <div className="surface" style={{ marginTop: 20 }}>
          <div className="surface-header">
            <span className="surface-title">{AI_DISCLOSURE_COPY.heading}</span>
          </div>
          {AI_DISCLOSURE_COPY.body.map((line, i) => (
            <p key={i} className="muted" style={{ fontSize: 12, margin: i === 0 ? 0 : '6px 0 0', lineHeight: 1.6 }}>
              {line}
            </p>
          ))}
        </div>
      </div>
    </>
  )
}
