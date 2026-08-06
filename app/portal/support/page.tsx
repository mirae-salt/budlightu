'use client'
import { useState } from 'react'

export default function SupportPage() {
  const [question, setQuestion] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setErr(null)
    setBusy(true)
    try {
      const res = await fetch('/api/portal/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      })
      const json = await res.json()
      if (!res.ok || !json.ok) { setErr(json.message ?? 'Something went wrong'); return }
      setSent(true)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <>
        <div className="topbar">
          <div className="crumbs"><span className="now">Support</span></div>
        </div>
        <h1>Thanks! We&rsquo;ll get back to you</h1>
        <p className="subtle">Your program manager will reply by email within 1–2 business days.</p>
      </>
    )
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">Support</span></div>
      </div>

      <div style={{ maxWidth: 680 }}>
        <h1>Ask a question</h1>
        <p className="subtle">
          Can&rsquo;t submit this month? Not sure about a receipt? Type your question and your program manager will get back to you.
        </p>

        <div className="surface stack" style={{ marginTop: 20 }}>
          <label htmlFor="support-q" className="sr-only">Your question</label>
          <textarea id="support-q" rows={6} value={question} onChange={e => setQuestion(e.target.value)} placeholder="What's going on?" aria-label="Your question" />
          <button onClick={submit} disabled={busy || question.trim().length < 5}>
            {busy ? 'Sending...' : 'Send'}
          </button>
        </div>
        {err && <p style={{ color: '#A31212', marginTop: 16 }}>{err}</p>}
      </div>
    </>
  )
}
