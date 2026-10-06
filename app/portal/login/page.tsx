'use client'
import { useState, useRef, useEffect } from 'react'
import { browserClient } from '@/lib/supabase-browser'
import { resolveBamId } from '@/lib/portal-bam'
import { getRole, isAdminRole } from '@/lib/auth-claims'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [phase, setPhase] = useState<'email' | 'otp' | 'error'>('email')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const emailRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { emailRef.current?.focus() }, [])

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
    let { error: verifyErr } = await sb.auth.verifyOtp({
      email,
      token: code,
      type: 'email'
    })
    if (verifyErr) {
      const fallback = await sb.auth.verifyOtp({
        email,
        token: code,
        type: 'magiclink'
      })
      if (!fallback.error) verifyErr = null
    }

    if (verifyErr) {
      setBusy(false)
      const msg = verifyErr.message || 'Verification failed'
      setError(msg.includes('expired') ? 'Code expired. Click "Resend code" to get a new one.' : msg)
      setOtp(['', '', '', '', '', ''])
      inputRefs.current[0]?.focus()
      return
    }

    const { data: userRes } = await sb.auth.getUser()

    // An administrator lands in /admin, which is their actual job. They also get a
    // test BAM account (see lib/admin-test-bam.ts), so sending them to the portal
    // first would open an onboarding form asking Robin for HER banking details.
    // The portal is one click away in the sidebar ("Switch to BAM Portal").
    if (isAdminRole(getRole(userRes.user))) {
      setBusy(false)
      window.location.href = '/admin'
      return
    }

    // P0-A: trusted app_metadata claim (with a bams.auth_user_id fallback),
    // never the client-writable user_metadata bag.
    const bamId = await resolveBamId(sb, userRes.user)

    if (bamId) {
      const { data: bam } = await sb
        .from('bams')
        .select('bank_name, street')
        .eq('id', bamId)
        .maybeSingle()

      setBusy(false)
      if (!bam?.bank_name || !bam?.street) {
        window.location.href = '/portal/onboarding'
        return
      }
    } else {
      setBusy(false)
    }

    // A public FAQ or terms reader who opened Support should land on the
    // question form after sign-in. Only this exact internal path is accepted.
    const requestedPage = new URLSearchParams(window.location.search).get('next')
    window.location.href = requestedPage === '/portal/support' ? requestedPage : '/portal/program'
  }

  return (
    <>
      <style>{`
        .login-split {
          display: grid; grid-template-columns: 1fr 1fr;
          min-height: 100vh; width: 100%;
        }
        @media (max-width: 860px) {
          .login-split { grid-template-columns: 1fr; }
          .login-hero { display: none; }
        }

        /* ── Hero panel ── */
        .login-hero {
          background: var(--bl-navy);
          display: flex; flex-direction: column;
          justify-content: center; align-items: center;
          padding: 60px 48px; position: relative; overflow: hidden;
        }
        .login-hero::before {
          content: ''; position: absolute; inset: 0;
          background:
            radial-gradient(ellipse 80% 60% at 30% 80%, rgba(58,173,217,0.15), transparent),
            radial-gradient(ellipse 60% 50% at 70% 20%, rgba(58,173,217,0.08), transparent);
          pointer-events: none;
        }
        .hero-logo { width: 200px; margin-bottom: 40px; position: relative; z-index: 1; }
        .hero-tagline {
          font-size: 28px; font-weight: 800; color: #fff;
          text-align: center; letter-spacing: -0.02em;
          line-height: 1.25; position: relative; z-index: 1;
          max-width: 320px;
        }
        .hero-tagline span { color: var(--bl-blue); }
        .hero-sub {
          font-size: 14px; color: rgba(255,255,255,0.45);
          margin-top: 16px; text-align: center;
          position: relative; z-index: 1;
          letter-spacing: 0.04em;
        }
        .hero-can {
          position: absolute; bottom: -20px; right: -30px;
          width: 240px; opacity: 0.12; pointer-events: none;
          transform: rotate(-15deg);
        }

        /* ── Form panel ── */
        .login-form-panel {
          display: flex; flex-direction: column;
          justify-content: center; align-items: center;
          padding: 48px 40px; background: #fff;
        }
        .login-form-inner { width: 100%; max-width: 400px; }
        .login-form-inner h1 {
          font-size: 22px; margin-bottom: 4px;
          text-transform: none; letter-spacing: -0.01em;
        }
        .login-subtitle {
          font-size: 14px; color: var(--midgray);
          margin-bottom: 28px;
        }

        /* ── Email field ── */
        .login-email-field { margin-bottom: 20px; }
        .login-email-field label {
          display: block; font-size: 13px; font-weight: 600;
          color: var(--bl-navy); margin-bottom: 6px;
        }
        .login-email-field input {
          width: 100%; padding: 12px 14px; font-size: 15px;
          border: 1.5px solid var(--stone); border-radius: 10px;
          background: var(--bl-silver); color: var(--bl-navy);
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .login-email-field input:focus {
          border-color: var(--bl-blue); outline: none;
          box-shadow: 0 0 0 3px rgba(58,173,217,0.12);
          background: #fff;
        }

        .login-submit {
          width: 100%; padding: 13px 0; font-size: 15px;
          font-weight: 700; border-radius: 10px;
          background: var(--bl-navy); color: #fff;
          border: none; cursor: pointer;
          transition: background 0.15s, transform 0.1s;
        }
        .login-submit:hover:not(:disabled) { background: #141c2e; }
        .login-submit:active:not(:disabled) { transform: scale(0.985); }
        .login-submit:disabled { opacity: 0.45; cursor: not-allowed; }
        .login-help-details { margin-top: 16px; color: var(--slate); font-size: 12px; line-height: 1.55; }
        .login-help-details summary { color: var(--bl-blue-ink); font-weight: 600; cursor: pointer; }
        .login-help-details p { margin: 8px 0 0; }
        .login-help-details ul { margin: 6px 0; padding-left: 20px; }

        .login-divider {
          display: flex; align-items: center; gap: 12px;
          margin: 24px 0 20px; color: var(--midgray); font-size: 12px;
        }
        .login-divider::before, .login-divider::after {
          content: ''; flex: 1; height: 1px;
          background: var(--stone);
        }

        /* ── Info cards ── */
        .login-info-card {
          display: flex; align-items: flex-start; gap: 10px;
          padding: 12px 14px; border-radius: 10px;
          font-size: 13px; line-height: 1.5;
        }
        .login-info-card.blue {
          background: rgba(58,173,217,0.06);
          border: 1px solid rgba(58,173,217,0.1);
          color: var(--bl-navy);
        }
        .login-info-card.muted {
          background: var(--bl-silver);
          color: var(--midgray); margin-top: 8px;
          font-size: 12.5px;
        }
        .login-info-icon {
          flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px;
        }

        /* ── OTP ── */
        .otp-grid {
          display: flex; gap: 10px;
          justify-content: center; margin: 24px 0 20px;
        }
        .otp-input {
          width: 48px; height: 56px; text-align: center;
          font-size: 24px; font-weight: 700; letter-spacing: 0;
          border-radius: 10px; border: 2px solid var(--stone);
          color: var(--bl-navy); background: var(--bl-silver);
          flex: 1 1 0; min-width: 0; max-width: 52px;
          transition: border-color 0.15s, background 0.15s;
        }
        .otp-input:focus {
          border-color: var(--bl-blue); outline: none;
          box-shadow: 0 0 0 3px rgba(58,173,217,0.12);
          background: #fff;
        }
        .otp-sent {
          text-align: center; font-size: 14px; color: var(--bl-navy);
          padding: 12px 16px; border-radius: 10px;
          background: rgba(58,173,217,0.06);
        }
        .login-actions {
          display: flex; justify-content: space-between;
          align-items: center; margin-top: 20px;
        }
        .link-btn {
          font-size: 13px; padding: 6px 0; background: none; border: none;
          color: var(--midgray); cursor: pointer; text-decoration: underline;
          text-underline-offset: 3px;
        }
        /*
         * The background reset is the load-bearing half of this rule.
         *
         * globals.css has a GLOBAL button:hover rule that sets background to bl-blue-dark on every
         * button element. .link-btn cleared its background in the base rule but declared only color
         * on hover, so the background fell through to the global one and a plain text link grew a
         * blue block behind it. Specificity was never the problem: this selector already wins, it
         * just was not saying anything about background.
         *
         * Darkening the text is the whole intended effect.
         */
        .link-btn:hover { color: #111827; background: none; }
        .resend-btn {
          font-size: 13px; padding: 8px 18px; background: var(--bl-silver);
          border: 1.5px solid var(--stone); border-radius: 8px;
          color: var(--bl-navy); cursor: pointer; font-weight: 600;
        }
        .resend-btn:hover { border-color: var(--bl-blue); }
        .resend-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .login-error {
          margin-top: 16px; padding: 10px 14px; border-radius: 10px;
          font-size: 13px; line-height: 1.5;
          background: rgba(163,18,18,0.06); border: 1px solid rgba(163,18,18,0.12);
          color: #A31212;
        }
      `}</style>

      <div className="login-split">
        {/* ── Left: branding hero ── */}
        <div className="login-hero">
          <img className="hero-logo" src="/brand/BudLightU-logo.png" alt="Bud Light U" />
          <div className="hero-tagline">
            Welcome to the<br /><span>BAM Portal</span>
          </div>
          <div className="hero-sub">Campus Ambassador Program</div>
          <img className="hero-can" src="/brand/hero-can.jpg" alt="" />
        </div>

        {/* ── Right: form ── */}
        <div className="login-form-panel">
          <div className="login-form-inner">
            {phase === 'email' && (
              <>
                <h1>Sign in</h1>
                <div className="login-subtitle">
                  Enter the email you applied with. We&rsquo;ll send a 6-digit code.
                </div>

                <div className="login-email-field">
                  <label htmlFor="login-email">Email address</label>
                  <input
                    ref={emailRef}
                    id="login-email" type="email" value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && email.includes('@') && sendOtp()}
                    placeholder="you@school.edu"
                    autoComplete="email"
                  />
                </div>

                <button
                  className="login-submit"
                  onClick={sendOtp}
                  disabled={busy || !email.includes('@')}
                >
                  {busy ? 'Sending...' : 'Send verification code'}
                </button>

                <details className="login-help-details">
                  <summary>Code not arriving at your work email?</summary>
                  <p>Check your junk folder or add these senders to your safe list:</p>
                  <ul>
                    <li>noreply@budlightu.com</li>
                    <li>onboarding@budlightu.com</li>
                  </ul>
                  <p>Outlook: Settings &rarr; Mail &rarr; Junk email &rarr; Safe senders</p>
                </details>
              </>
            )}

            {phase === 'otp' && (
              <>
                <h1>Enter your code</h1>
                <div className="login-subtitle">We sent a 6-digit code to <strong>{email}</strong></div>

                <div className="otp-grid" onPaste={handleOtpPaste}>
                  {otp.map((d, i) => (
                    <input
                      key={i}
                      ref={el => { inputRefs.current[i] = el }}
                      className="otp-input"
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={d}
                      onChange={e => handleOtpChange(i, e.target.value)}
                      onKeyDown={e => handleOtpKeyDown(i, e)}
                      autoFocus={i === 0}
                    />
                  ))}
                </div>
                <button
                  className="login-submit"
                  onClick={verifyOtp}
                  disabled={busy || otp.join('').length !== 6}
                >
                  {busy ? 'Verifying...' : 'Sign in'}
                </button>
                <div className="login-actions">
                  <button className="link-btn" onClick={() => { setPhase('email'); setOtp(['', '', '', '', '', '']); setError(null) }}>
                    &#8592; Different email
                  </button>
                  <button className="resend-btn" onClick={sendOtp} disabled={busy}>
                    {busy ? 'Sending...' : 'Resend code'}
                  </button>
                </div>

                <div style={{
                  marginTop: 16, padding: '12px 14px', borderRadius: 10,
                  background: 'rgba(58,173,217,0.06)', border: '1px solid rgba(58,173,217,0.12)',
                  fontSize: 13, lineHeight: 1.6, color: 'var(--bl-navy)'
                }}>
                  <strong>Not seeing the code?</strong> Check your spam or junk folder.
                </div>

                <div style={{
                  marginTop: 8, padding: '12px 14px', borderRadius: 10,
                  background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)',
                  fontSize: 12.5, lineHeight: 1.6, color: '#92400e'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    <strong style={{ color: '#b45309' }}>Still nothing on a work email?</strong>
                  </div>
                  <p style={{ margin: '0 0 6px' }}>
                    Add these two senders to your safe list, then resend:
                  </p>
                  <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>
                    <li><strong style={{ color: '#b45309' }}>noreply@budlightu.com</strong></li>
                    <li><strong style={{ color: '#b45309' }}>onboarding@budlightu.com</strong></li>
                  </ul>
                  <p style={{ margin: 0, fontSize: 12 }}>
                    In Outlook: Settings &rarr; Mail &rarr; Junk email &rarr; Safe senders
                  </p>
                </div>
              </>
            )}

            {error && <div className="login-error">{error}</div>}
          </div>
        </div>
      </div>
    </>
  )
}
