'use client'
import { useState, useEffect, use } from 'react'
import { BANK_SEED, otherBankNameProblem } from '@/lib/banks'
import { browserClient } from '@/lib/supabase-browser'
// Free text here let a student type "Ontario", which computeHst() throws on at invoice
// time. The list is derived from the tax table itself, so the two cannot drift.
import { PROVINCE_CODES } from '@/lib/invoice-payload'
import { HST_COPY } from '@/lib/hst-declaration'
import { WORK_AUTH_COPY, BANKING_ATTESTATION_COPY, AI_DISCLOSURE_COPY } from '@/lib/attestations'

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
/*
 * The five ticks the form will not submit without. They sit in three different
 * sections (banking, tax, consents), so "agree to all" has to name them in one place
 * or it silently stops covering whichever one gets added next.
 *
 * ai_training is NOT in this list and must never be. It is the one consent here that
 * can be refused, and sweeping a refusable consent into an "agree to all" is exactly
 * the bundling Shane Deen flagged on 2026-08-27 as failing the meaningful-consent
 * standard. It stays its own question with its own answer.
 */
const REQUIRED_TICKS = ['consent_terms', 'consent_ap_cc', 'hst_attested', 'work_auth', 'banking_owner'] as const

export default function OnboardingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [checking, setChecking] = useState(true)
  const [tokenValid, setTokenValid] = useState(false)
  const [step, setStep] = useState<'form' | 'done'>('form')
  const [email, setEmail] = useState('')
  const [form, setForm] = useState({
    first_name: '', last_name: '', phone: '',
    street: '', city: '', prov: '', postal: '', school_id: '',
    bank_name: '', bank_name_other: '', institution_no: '', transit_no: '', account_no: '',
    hst_number: '', hst_status: '', hst_attested: false, consent_ap_cc: true, consent_terms: false,
    work_auth: false, banking_owner: false, ai_training: false
  })

  /* True only when every required tick is on, so the master box tracks reality. */
  const allRequiredTicked = REQUIRED_TICKS.every(k => form[k] === true)

  function setAllRequired(on: boolean) {
    setForm(f => ({ ...f, ...Object.fromEntries(REQUIRED_TICKS.map(k => [k, on])) }))
  }
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
    if (form.bank_name === 'Other') {
      const problem = otherBankNameProblem(form.bank_name_other)
      if (problem) e.bank_name_other = problem
    }
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
              <div className="field"><label htmlFor="ob-first_name">Legal first name</label><input id="ob-first_name" autoComplete="given-name" value={form.first_name} onChange={e => setForm({...form, first_name: e.target.value})} style={fieldErrors.first_name ? errStyle : {}} />{fieldErrors.first_name && <span className="field-err">{fieldErrors.first_name}</span>}</div>
              <div className="field"><label htmlFor="ob-last_name">Legal last name</label><input id="ob-last_name" autoComplete="family-name" value={form.last_name} onChange={e => setForm({...form, last_name: e.target.value})} style={fieldErrors.last_name ? errStyle : {}} />{fieldErrors.last_name && <span className="field-err">{fieldErrors.last_name}</span>}</div>
            </div>
            <div className="field"><label htmlFor="ob-phone">Phone</label><input id="ob-phone" autoComplete="tel" value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} placeholder="647-555-0100" style={fieldErrors.phone ? errStyle : {}} />{fieldErrors.phone && <span className="field-err">{fieldErrors.phone}</span>}</div>
            <div className="field"><label htmlFor="ob-street">Street</label><input id="ob-street" autoComplete="address-line1" value={form.street} onChange={e => setForm({...form, street: e.target.value})} style={fieldErrors.street ? errStyle : {}} />{fieldErrors.street && <span className="field-err">{fieldErrors.street}</span>}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
              <div className="field"><label htmlFor="ob-city">City</label><input id="ob-city" autoComplete="address-level2" value={form.city} onChange={e => setForm({...form, city: e.target.value})} style={fieldErrors.city ? errStyle : {}} />{fieldErrors.city && <span className="field-err">{fieldErrors.city}</span>}</div>
              <div className="field"><label htmlFor="ob-prov">Province</label><select id="ob-prov" autoComplete="address-level1" value={form.prov} onChange={e => setForm({...form, prov: e.target.value})} style={fieldErrors.prov ? errStyle : {}}><option value="">Select...</option>{PROVINCE_CODES.map(p => <option key={p} value={p}>{p}</option>)}</select>{fieldErrors.prov && <span className="field-err">{fieldErrors.prov}</span>}</div>
              <div className="field"><label htmlFor="ob-postal">Postal</label><input id="ob-postal" autoComplete="postal-code" value={form.postal} onChange={e => setForm({...form, postal: e.target.value})} placeholder="M5V 3L9" style={fieldErrors.postal ? errStyle : {}} />{fieldErrors.postal && <span className="field-err">{fieldErrors.postal}</span>}</div>
            </div>
            <div className="field"><label htmlFor="ob-school_id">School / campus</label><input id="ob-school_id" autoComplete="off" value={form.school_id} onChange={e => setForm({...form, school_id: e.target.value})} style={fieldErrors.school_id ? errStyle : {}} />{fieldErrors.school_id && <span className="field-err">{fieldErrors.school_id}</span>}</div>
          </div>

          <div className="surface">
            <h2 style={{ marginTop: 0 }}>Direct deposit</h2>
            <p className="subtle" style={{ fontSize: 13, marginTop: 0 }}>These fields are encrypted at rest. Only Salt&rsquo;s payment system can decrypt.</p>
          {/* Under the account fields on purpose: it is a statement about the numbers
              immediately above it. Same wording as the signed-in onboarding page, from
              lib/attestations, so the two forms cannot drift. */}
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={form.banking_owner}
              onChange={e => setForm({ ...form, banking_owner: e.target.checked })}
              style={{ width: 'auto', marginTop: 3, flexShrink: 0 }}
            />
            <span style={{ fontSize: 13, color: 'var(--midgray)', lineHeight: 1.5 }}>
              {BANKING_ATTESTATION_COPY.checkbox}
            </span>
          </label>
            <div className="field">
              <label htmlFor="ob-bank_name">Bank</label>
              <select id="ob-bank_name" value={form.bank_name} onChange={e => setForm({...form, bank_name: e.target.value})} style={fieldErrors.bank_name ? errStyle : {}}>
                <option value="">Select…</option>
                {BANK_SEED.map(b => <option key={b.normalized} value={b.displayName}>{b.displayName}</option>)}
                <option value="Other">Other (type your bank name)</option>
              </select>
              {fieldErrors.bank_name && <span className="field-err">{fieldErrors.bank_name}</span>}
            </div>
            {form.bank_name === 'Other' && (
              <div className="field">
                <label htmlFor="ob-bank_name_other">Your bank name</label>
                <input id="ob-bank_name_other" autoComplete="off"
                  value={form.bank_name_other}
                  onChange={e => setForm({ ...form, bank_name_other: e.target.value })}
                  placeholder="e.g. Kawartha Credit Union"
                  style={fieldErrors.bank_name_other ? errStyle : {}}
                />
                {fieldErrors.bank_name_other && <span className="field-err">{fieldErrors.bank_name_other}</span>}
                {/* The cross-check only exists for banks on our list. Say so, rather
                    than letting a typo in the institution number look checked. */}
                <span className="muted" style={{ fontSize: 11, display: 'block', marginTop: 4, lineHeight: 1.5 }}>
                  Your bank is not on our list, so we cannot check the institution number for you.
                  Copy all three numbers straight off a void cheque or your direct deposit form.
                </span>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 12 }}>
              <div className="field"><label htmlFor="ob-institution_no">Institution # (3 digits)</label><input id="ob-institution_no" autoComplete="off" inputMode="numeric" maxLength={3} value={form.institution_no} onChange={e => setForm({...form, institution_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.institution_no ? errStyle : {}} />{fieldErrors.institution_no && <span className="field-err">{fieldErrors.institution_no}</span>}</div>
              <div className="field"><label htmlFor="ob-transit_no">Transit # (5 digits)</label><input id="ob-transit_no" autoComplete="off" inputMode="numeric" maxLength={5} value={form.transit_no} onChange={e => setForm({...form, transit_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.transit_no ? errStyle : {}} />{fieldErrors.transit_no && <span className="field-err">{fieldErrors.transit_no}</span>}</div>
              <div className="field"><label htmlFor="ob-account_no">Account #</label><input id="ob-account_no" autoComplete="off" inputMode="numeric" value={form.account_no} onChange={e => setForm({...form, account_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.account_no ? errStyle : {}} />{fieldErrors.account_no && <span className="field-err">{fieldErrors.account_no}</span>}</div>
            </div>
          </div>

          {/*
            THE TAX STATUS DECLARATION.

            This replaced a single "HST number (optional)" text box. Everybody left that
            blank, so tax was $0 on every invoice, but the reason on file was "nobody
            typed anything" rather than "nobody is registered". Only one of those is
            something the contractor actually said.

            Every string comes from lib/hst-declaration so the wording lives in one
            place and carries a version, because this is text somebody ticks a box
            against.
          */}
          <div className="surface" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>{HST_COPY.heading}</h3>
              <p className="subtle" style={{ margin: 0, fontWeight: 400 }}>{HST_COPY.intro}</p>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 8 }}>{HST_COPY.question}</label>

              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 10 }}>
                <input
                  type="radio"
                  name="hst_status"
                  checked={form.hst_status === 'not_registered'}
                  onChange={() => setForm({ ...form, hst_status: 'not_registered' })}
                  style={{ width: 'auto', marginTop: 3, flexShrink: 0 }}
                />
                <span className="subtle" style={{ fontWeight: 400 }}>{HST_COPY.notRegistered}</span>
              </label>

              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="hst_status"
                  checked={form.hst_status === 'registered'}
                  onChange={() => setForm({ ...form, hst_status: 'registered' })}
                  style={{ width: 'auto', marginTop: 3, flexShrink: 0 }}
                />
                <span className="subtle" style={{ fontWeight: 400 }}>{HST_COPY.registered}</span>
              </label>

              {form.hst_status === 'registered' && (
                <div style={{ marginTop: 10, marginLeft: 24 }}>
                  <div className="field">
                    <label htmlFor="ob-hst_number">{HST_COPY.numberLabel}</label>
                    <input id="ob-hst_number" autoComplete="off"
                      value={form.hst_number}
                      onChange={e => setForm({ ...form, hst_number: e.target.value })}
                      placeholder={HST_COPY.numberPlaceholder}
                      style={fieldErrors.hst_number ? errStyle : {}}
                    />
                    {fieldErrors.hst_number && <span className="field-err">{fieldErrors.hst_number}</span>}
                  </div>
                  <p className="subtle" style={{ margin: '6px 0 0', fontWeight: 400, fontSize: 12 }}>
                    {HST_COPY.verificationNote}
                  </p>
                </div>
              )}
            </div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.hst_attested}
                onChange={e => setForm({ ...form, hst_attested: e.target.checked })}
                style={{ width: 'auto', marginTop: 3, flexShrink: 0 }}
              />
              <span className="subtle" style={{ fontWeight: 400 }}>{HST_COPY.attestation}</span>
            </label>
          </div>

          <div className="surface" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/*
              Ticking all five one at a time is five clicks for statements a student has
              already read once. This is the same control Korean consent forms use, with
              the same rule about scope: it covers the required ones and nothing else,
              and it says which.

              It is derived, not stored. Unticking any one below turns this back off,
              which is the honest state to show rather than leaving a master tick lit
              over an unticked box.
            */}
            <label
              style={{
                display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer',
                paddingBottom: 12, marginBottom: 4, borderBottom: '1px solid var(--stone)'
              }}
            >
              <input
                type="checkbox"
                checked={allRequiredTicked}
                onChange={e => setAllRequired(e.target.checked)}
                style={{ width: 'auto', flexShrink: 0 }}
              />
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                Agree to all of the below
                <span className="muted" style={{ display: 'block', fontSize: 11, fontWeight: 400, marginTop: 2 }}>
                  Required to finish. The optional question further down is separate.
                </span>
              </span>
            </label>
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

            {/* Nothing in the signed BAM contract covers work authorisation, and a study
                permit's off-campus allowance generally does not extend to self-employment. */}
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.work_auth} onChange={e => setForm({...form, work_auth: e.target.checked})} style={{ width: 'auto', marginTop: 3, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--midgray)', lineHeight: 1.5 }}>
                {WORK_AUTH_COPY.checkbox}
                <span style={{ display: 'block', fontSize: 11, marginTop: 3 }}>{WORK_AUTH_COPY.help}</span>
              </span>
            </label>
          </div>

          {/* Separate from the block above because this is the one thing here that can be
              refused. Bundling refusable consent into terms somebody must accept to get
              paid is how consent stops meaning anything. */}
          <div className="surface" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{AI_DISCLOSURE_COPY.heading}</span>
            {AI_DISCLOSURE_COPY.body.map((line, i) => (
              <p key={i} className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>{line}</p>
            ))}
            <p style={{ fontSize: 13, margin: '6px 0 0', fontWeight: 600 }}>{AI_DISCLOSURE_COPY.trainingQuestion}</p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.ai_training} onChange={e => setForm({...form, ai_training: e.target.checked})} style={{ width: 'auto', marginTop: 3, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--midgray)', lineHeight: 1.5 }}>
                {AI_DISCLOSURE_COPY.trainingCheckbox}
                <span style={{ display: 'block', fontSize: 11, marginTop: 3 }}>{AI_DISCLOSURE_COPY.trainingHelp}</span>
              </span>
            </label>
          </div>

          <button onClick={submitAll} disabled={busy || !form.consent_ap_cc || !form.consent_terms || !form.hst_attested
            || !form.work_auth || !form.banking_owner
            || form.hst_status === ''
            || (form.hst_status === 'registered' && !form.hst_number.trim())}>
            {busy ? 'Submitting…' : 'Finish onboarding'}
          </button>
          {/* The server refused the write because the institution number disagrees with our
              bank table, and is asking rather than overruling. Their number wins if they
              confirm: they are reading their own void cheque, and our 32-row table has
              been wrong twice. See lib/institution-confirm.ts. */}
          {institutionAsk && (
            <div style={{
              padding: '14px 16px', borderRadius: 10, marginBottom: 12,
              background: '#fffbeb', border: '1px solid #fcd34d', color: '#78350f'
            }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Is this right?</div>
              <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.6 }}>{institutionAsk.message}</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => submitOnboarding(true)} disabled={busy}>
                  {busy ? 'Saving...' : `Yes, use ${institutionAsk.submitted}`}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => setInstitutionAsk(null)}
                >
                  Let me fix it
                </button>
              </div>
            </div>
          )}
          {error && <p style={{ color: '#A31212' }}>{error}</p>}
        </div>
      )}
    </main>
  )
}
