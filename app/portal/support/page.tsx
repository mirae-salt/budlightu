'use client'
import { useState } from 'react'
import { browserClient } from '@/lib/supabase-browser'

export default function SupportPage() {
  const [question, setQuestion] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setErr(null)
    const sb = browserClient()
    const { data: userRes } = await sb.auth.getUser()
    if (!userRes.user) { setErr('Please log in first.'); return }
    const bamId = (userRes.user.user_metadata as { bam_id?: string }).bam_id
    const { error } = await sb.from('portal_questions').insert({ bam_id: bamId, question })
    if (error) setErr(error.message)
    else setSent(true)
  }

  if (sent) {
    return (
      <main className="container" style={{ maxWidth: 600 }}>
        <h1>Thanks — we&rsquo;ll get back to you</h1>
        <p className="subtle">Robin will reply by email within 1–2 business days.</p>
      </main>
    )
  }

  return (
    <main className="container" style={{ maxWidth: 600 }}>
      <p className="eyebrow">SUPPORT</p>
      <h1>Ask a question</h1>
      <p className="subtle">
        Can&rsquo;t submit this month? Not sure about a receipt? Type your question and Robin will get back to you.
      </p>

      <div className="hero-card stack" style={{ marginTop: 24 }}>
        <textarea rows={6} value={question} onChange={e => setQuestion(e.target.value)} placeholder="What's going on?" />
        <button onClick={submit} disabled={question.trim().length < 5}>Send</button>
      </div>
      {err && <p style={{ color: '#A31212', marginTop: 16 }}>{err}</p>}
    </main>
  )
}
