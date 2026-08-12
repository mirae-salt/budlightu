'use client'
import { useState, useEffect, use } from 'react'
import { BANK_SEED } from '@/lib/banks'
import { browserClient } from '@/lib/supabase-browser'
// Free text here let a student type "Ontario", which computeHst() throws on at invoice
// time. The list is derived from the tax table itself, so the two cannot drift.
import { PROVINCE_CODES } from '@/lib/invoice-payload'

/**
 * Onboarding form — invite-token gated (P0-3).
 * Token check auto-fills email + first name, then shows the full form directly.
 *
 * Sign-in on completion: onboarding creates the auth user server-side, so the
 * browser has no session yet. Sending the BAM to /portal/login made them retype
 * the email they just confirmed and start the whole code flow over. Instead the
 * OTP is requested automatically as soon as the form is submitted, and the code
 * is entered right here, so finishing onboarding lands them in the portal.
 */
export default function OnboardingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [checking, setChecking] = useState(true)
  const [tokenValid, setTokenValid] = useState(false)
  const [step, setStep] = useState<'form' | 'done'>('form')
  const [email, setEmail] = useState('')
  const [form, setForm] = useState({
    first_name: '', last_name: '', phone: '',
    street: '', city: '', prov: '', postal: '', school_id: '',
    bank_name: '', institution_no: '', transit_no: '', account_no: '',
    hst_number: '', consent_ap_cc: true, consent_terms: false
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The server refuses the write when the institution number the BAM typed disagrees
  // with our bank table, and asks instead. Their number wins if they confirm it: they are
  // reading their own void cheque, and our table has been wrong before.
  // See lib/institution-confirm.ts.
  const [institutionAsk, setInstitutionAsk] = useState<{ message: string; submitted: string; ours: string } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)

  // Sign-in state for the done screen
  const [otp, setOtp] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)

  async function sendCode() {
    setSignInError(null)
    const sb = browserClient()
    const { error: otpErr } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false }
    })
    if (otpErr) {
      setSignInError(`We could not send your sign-in code: ${otpErr.message}`)
      return
    }
    setCodeSent(true)
  }

  async function verifyCode() {
    const code = otp.replace(/\D/g, '')
    if (code.length !== 6) {
      setSignInError('Enter the 6 digit code from your email.')
      return
    }
    setSigningIn(true); setSignInError(null)
    const sb = browserClient()
    let { error: verifyErr } = await sb.auth.verifyOtp({ email, token: code, type: 'email' })
    if (verifyErr) {
      const fallback = await sb.auth.verifyOtp({ email, token: code, type: 'magiclink' })
      if (!fallback.error) verifyErr = null
    }
    if (verifyErr) {
      setSigningIn(false)
      const msg = verifyErr.message || 'Verification failed'
      setSignInError(msg.includes('expired') ? 'That code expired. Send a new one below.' : msg)
      setOtp('')
      return
    }
    window.location.href = '/portal/program'
  }

  // Upfront token validity check — surfaces a dead/used invite link
  // immediately instead of after the whole form is filled out.
  useEffect(() => {
    async function checkToken() {
      try {
        const resp = await fetch(`/api/portal/onboarding/check-token?token=${encodeURIComponent(token)}`)
        const j = await resp.json()
        setTokenValid(!!j.ok)
        if (j.ok && j.email) setEmail(j.email)
        if (j.ok) setForm(f => ({
          ...f,
          ...(j.first_name ? { first_name: j.first_name } : {}),
          ...(j.last_name ? { last_name: j.last_name } : {})
        }))
      } catch {
        setTokenValid(false)
      } finally {
        setChecking(false)
      }
    }
    checkToken()
  }, [token])

  function validate(): Record<string, string> {
    const e: Record<string, string> = {}
    if (!form.first_name.trim()) e.first_name = 'Required'
    if (!form.last_name.trim()) e.last_name = 'Required'
    if (!form.phone.trim()) e.phone = 'Required'
    if (!form.street.trim()) e.street = 'Required'
    if (!form.city.trim()) e.city = 'Required'
    if (!form.prov.trim()) e.prov = 'Required'
    if (!form.postal.trim()) e.postal = 'Required'
    if (!form.school_id.trim()) e.school_id = 'Required'
    if (!form.bank_name) e.bank_name = 'Select a bank'
    if (form.bank_name && form.bank_name !== 'Other') {
      if (form.institution_no.length !== 3) e.institution_no = 'Must be 3 digits'
      if (form.transit_no.length !== 5) e.transit_no = 'Must be 5 digits'
      if (!form.account_no) e.account_no = 'Required'
    }
    return e
  }

  async function submitAll() {
    const errs = validate()
    setFieldErrors(errs)
    if (Object.keys(errs).length > 0) return

    void submitOnboarding(false)
  }

  async function submitOnboarding(institutionConfirmed: boolean) {
    setBusy(true); setError(null)
    if (institutionConfirmed) setInstitutionAsk(null)
    try {
      const resp = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invite_token: token,
          form: { ...form, email, institution_confirmed: institutionConfirmed }
        })
      })
      const j = await resp.json()
      if (j.needsInstitutionConfirm) {
        // Not an error: a question. Nothing was saved, and re-submitting with the flag
        // stores exactly what they typed.
        setInstitutionAsk({ message: j.message, submitted: j.submittedInstitution, ours: j.ourInstitution })
        setBusy(false)
        return
      }
      if (!resp.ok || !j.ok) { setError(j.message ?? 'Failed'); setBusy(false); return }
      setDone(j.message)
      setStep('done')
      // Request the sign-in code immediately so the BAM never sees a login form.
      void sendCode()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const errStyle = { borderColor: '#A31212' }

  if (checking) {
    return (
      <main className="container" style={{ maxWidth: 680 }}>
        <p className="eyebrow">WELCOME TO BUD LIGHT U</p>
        <h1>Set up your account</h1>
        <p className="subtle">Checking your invite link…</p>
      </main>
    )
  }

  if (!tokenValid) {
    return (
      <main className="container" style={{ maxWidth: 680 }}>
        <p className="eyebrow">WELCOME TO BUD LIGHT U</p>
        <h1>Invite link not valid</h1>
        <div className="surface" style={{ marginTop: 24 }}>
          <p className="subtle" style={{ margin: 0 }}>
            This invite link is invalid or has already been used. Please contact your program manager.
          </p>
        </div>
      </main>
    )
  }

  if (step === 'done' && done) {
    return (
      <main className="container" style={{ maxWidth: 680 }}>
        <p className="eyebrow">ALL SET</p>
        <h1>You&rsquo;re onboarded 🎉</h1>
        <p className="subtle">{done}</p>

        <div className="surface" style={{ marginTop: 24 }}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>One last step: sign in</h3>
          <p className="subtle" style={{ fontSize: 14 }}>
            {codeSent
              ? <>We sent a 6 digit code to <strong>{email}</strong>. Enter it below to open your portal.</>
              : <>Sending a 6 digit sign-in code to <strong>{email}</strong>…</>}
          </p>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
            <input
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => { if (e.key === 'Enter') void verifyCode() }}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              aria-label="6 digit sign-in code"
              style={{ width: 140, fontSize: 20, letterSpacing: '0.25em', textAlign: 'center' }}
            />
            <button onClick={verifyCode} disabled={signingIn || otp.replace(/\D/g, '').length !== 6}>
              {signingIn ? 'Signing in…' : 'Open my portal'}
            </button>
            <button className="btn-ghost" onClick={sendCode} disabled={signingIn} style={{ fontSize: 13 }}>
              Resend code
            </button>
          </div>

          {signInError && (
            <p style={{ color: '#A31212', fontSize: 13, marginTop: 10 }}>{signInError}</p>
          )}

          <div style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 8,
            background: 'rgba(180,83,9,0.06)', border: '1px solid rgba(180,83,9,0.12)',
            fontSize: 13, lineHeight: 1.6
          }}>
            <strong style={{ color: '#b45309' }}>No code on a work email?</strong>
            <p style={{ margin: '4px 0 6px' }}>
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

          <p className="subtle" style={{ fontSize: 12, marginTop: 12 }}>
            Having trouble? You can also <a href="/portal/login" style={{ color: 'var(--teal-sub)' }}>sign in from the login page</a>.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="container" style={{ maxWidth: 680 }}>
      <p className="eyebrow">WELCOME TO BUD LIGHT U</p>
      <h1>Set up your account</h1>
      <p className="subtle">Takes about 3 minutes. Your banking info is encrypted before it&rsquo;s stored.</p>

      {/* Full form — email auto-filled from invite token */}
      {step === 'form' && (
        <div className="stack" style={{ marginTop: 24 }}>

          <div className="surface">
            <h2 style={{ marginTop: 0 }}>You</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field"><label>Legal first name</label><input value={form.first_name} onChange={e => setForm({...form, first_name: e.target.value})} style={fieldErrors.first_name ? errStyle : {}} />{fieldErrors.first_name && <span className="field-err">{fieldErrors.first_name}</span>}</div>
              <div className="field"><label>Legal last name</label><input value={form.last_name} onChange={e => setForm({...form, last_name: e.target.value})} style={fieldErrors.last_name ? errStyle : {}} />{fieldErrors.last_name && <span className="field-err">{fieldErrors.last_name}</span>}</div>
            </div>
            <div className="field"><label>Phone</label><input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} placeholder="647-555-0100" style={fieldErrors.phone ? errStyle : {}} />{fieldErrors.phone && <span className="field-err">{fieldErrors.phone}</span>}</div>
            <div className="field"><label>Street</label><input value={form.street} onChange={e => setForm({...form, street: e.target.value})} style={fieldErrors.street ? errStyle : {}} />{fieldErrors.street && <span className="field-err">{fieldErrors.street}</span>}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
              <div className="field"><label>City</label><input value={form.city} onChange={e => setForm({...form, city: e.target.value})} style={fieldErrors.city ? errStyle : {}} />{fieldErrors.city && <span className="field-err">{fieldErrors.city}</span>}</div>
              <div className="field"><label>Province</label><select value={form.prov} onChange={e => setForm({...form, prov: e.target.value})} style={fieldErrors.prov ? errStyle : {}}><option value="">Select...</option>{PROVINCE_CODES.map(p => <option key={p} value={p}>{p}</option>)}</select>{fieldErrors.prov && <span className="field-err">{fieldErrors.prov}</span>}</div>
              <div className="field"><label>Postal</label><input value={form.postal} onChange={e => setForm({...form, postal: e.target.value})} placeholder="M5V 3L9" style={fieldErrors.postal ? errStyle : {}} />{fieldErrors.postal && <span className="field-err">{fieldErrors.postal}</span>}</div>
            </div>
            <div className="field"><label>School / campus</label><input value={form.school_id} onChange={e => setForm({...form, school_id: e.target.value})} style={fieldErrors.school_id ? errStyle : {}} />{fieldErrors.school_id && <span className="field-err">{fieldErrors.school_id}</span>}</div>
          </div>

          <div className="surface">
            <h2 style={{ marginTop: 0 }}>Direct deposit</h2>
            <p className="subtle" style={{ fontSize: 13, marginTop: 0 }}>These fields are encrypted at rest. Only Salt&rsquo;s payment system can decrypt.</p>
            <div className="field">
              <label>Bank</label>
              <select value={form.bank_name} onChange={e => setForm({...form, bank_name: e.target.value})} style={fieldErrors.bank_name ? errStyle : {}}>
                <option value="">Select…</option>
                {BANK_SEED.map(b => <option key={b.normalized} value={b.displayName}>{b.displayName}</option>)}
                <option value="Other">Other (contact your program manager)</option>
              </select>
              {fieldErrors.bank_name && <span className="field-err">{fieldErrors.bank_name}</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 12 }}>
              <div className="field"><label>Institution # (3 digits)</label><input inputMode="numeric" maxLength={3} value={form.institution_no} onChange={e => setForm({...form, institution_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.institution_no ? errStyle : {}} />{fieldErrors.institution_no && <span className="field-err">{fieldErrors.institution_no}</span>}</div>
              <div className="field"><label>Transit # (5 digits)</label><input inputMode="numeric" maxLength={5} value={form.transit_no} onChange={e => setForm({...form, transit_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.transit_no ? errStyle : {}} />{fieldErrors.transit_no && <span className="field-err">{fieldErrors.transit_no}</span>}</div>
              <div className="field"><label>Account #</label><input inputMode="numeric" value={form.account_no} onChange={e => setForm({...form, account_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.account_no ? errStyle : {}} />{fieldErrors.account_no && <span className="field-err">{fieldErrors.account_no}</span>}</div>
            </div>
            <div className="field"><label>HST number (optional)</label><input value={form.hst_number} onChange={e => setForm({...form, hst_number: e.target.value})} placeholder="123456789 RT 0001" /></div>
          </div>

          <div className="surface" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.consent_terms} onChange={e => setForm({...form, consent_terms: e.target.checked})} style={{ width: 'auto', marginTop: 3, flexShrink: 0 }} />
              <span className="subtle" style={{ fontWeight: 400 }}>
                I agree to the{' '}
                <a href="/portal/terms" target="_blank" rel="noopener noreferrer">Bud Light U program terms</a>
                {' '}(opens in a new tab). Submitting fraudulent, reused, or AI-generated receipts may result in forfeiture of reimbursement and removal from the program. I will retain original receipts for at least 6 months.
              </span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.consent_ap_cc} onChange={e => setForm({...form, consent_ap_cc: e.target.checked})} style={{ width: 'auto', marginTop: 3, flexShrink: 0 }} />
              <span className="subtle" style={{ fontWeight: 400 }}>
                I consent to Salt XC processing my banking information for the sole purpose of paying my monthly BAM invoice.
              </span>
            </label>
          </div>

          <button onClick={submitAll} disabled={busy || !form.consent_ap_cc || !form.consent_terms}>
            {busy ? 'Submitting…' : 'Finish onboarding'}
          </button>
          {error && <p style={{ color: '#A31212' }}>{error}</p>}
        </div>
      )}
    </main>
  )
}
