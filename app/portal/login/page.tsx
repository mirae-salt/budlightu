'use client'
import { useState, useRef } from 'react'
import { browserClient } from '@/lib/supabase-browser'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [phase, setPhase] = useState<'email' | 'otp' | 'error'>('email')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  async function sendOtp() {
    setBusy(true); setError(null)

    const check = await fetch('/api/auth/roster-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    })
    const checkJson = await check.json()
    if (!check.ok || !checkJson.ok) {
      setError(checkJson.message ?? 'Email not found in roster.')
      setBusy(false)
      return
    }

    const sb = browserClient()
    const { error: otpErr } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false }
    })

    setBusy(false)
    if (otpErr) {
      setError(otpErr.message)
      return
    }
    setPhase('otp')
  }

  function handleOtpChange(idx: number, val: string) {
    if (!/^\d*$/.test(val)) return
    const next = [...otp]
    next[idx] = val.slice(-1)
    setOtp(next)
    if (val && idx < 5) inputRefs.current[idx + 1]?.focus()
  }

  function handleOtpKeyDown(idx: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !otp[idx] && idx > 0) {
      inputRefs.current[idx - 1]?.focus()
    }
  }

  function handleOtpPaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (!pasted) return
    e.preventDefault()
    const next = [...otp]
    for (let i = 0; i < 6; i++) next[i] = pasted[i] || ''
    setOtp(next)
    const focusIdx = Math.min(pasted.length, 5)
    inputRefs.current[focusIdx]?.focus()
  }

  async function verifyOtp() {
    const code = otp.join('')
    if (code.length !== 6) return
    setBusy(true); setError(null)

    const sb = browserClient()
    const { error: verifyErr } = await sb.auth.verifyOtp({
      email,
      token: code,
      type: 'email'
    })

    setBusy(false)
    if (verifyErr) {
      setError('Invalid or expired code. Please try again.')
      setOtp(['', '', '', '', '', ''])
      inputRefs.current[0]?.focus()
      return
    }

    window.location.href = '/portal/dashboard'
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">Sign in</span></div>
      </div>

      <div style={{ maxWidth: 420 }}>
        <p className="eyebrow">BUD LIGHT U</p>
        <h1>Sign in to the portal</h1>

        {phase === 'email' && (
          <div className="surface stack" style={{ marginTop: 24 }}>
            <div className="field">
              <label htmlFor="email">Your email</label>
              <input
                id="email" type="email" value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && email.includes('@') && sendOtp()}
                placeholder="you@school.edu"
              />
            </div>
            <button onClick={sendOtp} disabled={busy || !email.includes('@')}>
              {busy ? 'Sending...' : 'Send verification code'}
            </button>
            <p className="muted" style={{ fontSize: 13 }}>
              We&rsquo;ll email you a 6-digit code to sign in &mdash; no password needed.
            </p>
          </div>
        )}

        {phase === 'otp' && (
          <div className="surface stack" style={{ marginTop: 24 }}>
            <p style={{ fontSize: 14, color: 'var(--bl-navy)', marginBottom: 4 }}>
              Enter the 6-digit code sent to <strong>{email}</strong>
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', margin: '16px 0' }} onPaste={handleOtpPaste}>
              {otp.map((d, i) => (
                <input
                  key={i}
                  ref={el => { inputRefs.current[i] = el }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={e => handleOtpChange(i, e.target.value)}
                  onKeyDown={e => handleOtpKeyDown(i, e)}
                  style={{
                    width: 48, height: 56, textAlign: 'center',
                    fontSize: 24, fontWeight: 700, letterSpacing: 0,
                    borderRadius: 8, border: '2px solid var(--border)',
                    color: 'var(--bl-navy)'
                  }}
                />
              ))}
            </div>
            <button onClick={verifyOtp} disabled={busy || otp.join('').length !== 6}>
              {busy ? 'Verifying...' : 'Sign in'}
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <button className="btn-ghost" onClick={() => { setPhase('email'); setOtp(['', '', '', '', '', '']); setError(null) }}
                style={{ fontSize: 13, padding: '4px 0' }}>
                Use a different email
              </button>
              <button className="btn-ghost" onClick={sendOtp} disabled={busy}
                style={{ fontSize: 13, padding: '4px 0' }}>
                Resend code
              </button>
            </div>
          </div>
        )}

        {error && <p style={{ color: '#A31212', marginTop: 16, fontSize: 14 }}>{error}</p>}
      </div>
    </>
  )
}
