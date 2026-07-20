'use client'
import { useState } from 'react'
import { browserClient } from '@/lib/supabase-browser'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [phase, setPhase] = useState<'email' | 'otp' | 'done'>('email')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function sendOtp() {
    setBusy(true); setError(null)
    const sb = browserClient()
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
    setBusy(false)
    if (error) setError(error.message)
    else setPhase('otp')
  }

  async function verifyOtp() {
    setBusy(true); setError(null)
    const sb = browserClient()
    const { error } = await sb.auth.verifyOtp({ email, token: code, type: 'email' })
    setBusy(false)
    if (error) setError(error.message)
    else {
      setPhase('done')
      window.location.href = '/portal/dashboard'
    }
  }

  return (
    <main className="container" style={{ maxWidth: 480 }}>
      <p className="eyebrow">BUD LIGHT U · SIGN IN</p>
      <h1>Log in to the portal</h1>

      {phase === 'email' && (
        <div className="stack" style={{ marginTop: 24 }}>
          <div className="field">
            <label htmlFor="email">Your email</label>
            <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@school.edu" />
          </div>
          <button onClick={sendOtp} disabled={busy || !email}>Send code</button>
          <p className="muted" style={{ fontSize: 13 }}>We&rsquo;ll email you a 6-digit code. No password needed.</p>
        </div>
      )}

      {phase === 'otp' && (
        <div className="stack" style={{ marginTop: 24 }}>
          <p>Sent a code to <strong>{email}</strong>. Check your inbox (and spam).</p>
          <div className="field">
            <label htmlFor="code">6-digit code</label>
            <input id="code" inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
          </div>
          <button onClick={verifyOtp} disabled={busy || code.length !== 6}>Verify &amp; sign in</button>
          <button className="btn-ghost" onClick={() => setPhase('email')}>Use a different email</button>
        </div>
      )}

      {error && <p style={{ color: '#A31212', marginTop: 16 }}>{error}</p>}
    </main>
  )
}
