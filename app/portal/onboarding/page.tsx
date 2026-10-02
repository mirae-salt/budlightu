'use client'
import { useState, useEffect } from 'react'
import { browserClient } from '@/lib/supabase-browser'
import { BANK_SEED, otherBankNameProblem } from '@/lib/banks'
// Free text here let a student type "Ontario", which computeHst() throws on at invoice
// time. The list is derived from the tax table itself, so the two cannot drift.
import { PROVINCE_CODES } from '@/lib/invoice-payload'
import { HST_COPY } from '@/lib/hst-declaration'
import { WORK_AUTH_COPY, BANKING_ATTESTATION_COPY, AI_DISCLOSURE_COPY } from '@/lib/attestations'
import { INVOICE_GENERATE_DAY } from '@/lib/cycle-schedule'

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

export default function OnboardingPage() {
  const [loading, setLoading] = useState(true)
  const [bamId, setBamId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState('')
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
  // The server refuses the write when the institution number disagrees with our bank
  // table, and asks instead of overruling. See lib/institution-confirm.ts.
  const [institutionAsk, setInstitutionAsk] = useState<{ message: string; submitted: string; ours: string } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [done, setDone] = useState(false)

  useEffect(() => {
    async function init() {
      const isDev = process.env.NODE_ENV === 'development'
      const sb = browserClient()
      const { data: { user } } = await sb.auth.getUser()

      if (!user && !isDev) { window.location.href = '/portal/login'; return }

      if (user) {
        setUserEmail(user.email ?? '')
        const { data: bam } = await sb
          .from('bams')
          .select('id, first_name, last_name')
          .eq('auth_user_id', user.id)
          .single()

        if (bam) {
          setBamId(bam.id)
          if (bam.first_name) setForm(f => ({ ...f, first_name: bam.first_name }))
          if (bam.last_name) setForm(f => ({ ...f, last_name: bam.last_name }))
        }
      } else {
        setUserEmail('demo.bam@school.edu')
      }
      setLoading(false)
    }
    init()
  }, [])

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

  async function submitForm() {
    const errs = validate()
    setFieldErrors(errs)
    if (Object.keys(errs).length > 0) return

    void submitOnboarding(false)
  }

  async function submitOnboarding(institutionConfirmed: boolean) {
    setBusy(true); setError(null)
    if (institutionConfirmed) setInstitutionAsk(null)
    try {
      const resp = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form: { ...form, email: userEmail, institution_confirmed: institutionConfirmed }
        })
      })
      const j = await resp.json()
      if (j.needsInstitutionConfirm) {
        // A question, not an error. Nothing was saved; re-submitting with the flag stores
        // exactly what they typed.
        setInstitutionAsk({ message: j.message, submitted: j.submittedInstitution, ours: j.ourInstitution })
        setBusy(false)
        return
      }
      if (!resp.ok || !j.ok) { setError(j.message ?? 'Something went wrong'); setBusy(false); return }
      setDone(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const errStyle = { borderColor: '#A31212' }

  if (loading) return (
    <>
      <div className="topbar"><div className="crumbs"><span className="now">Onboarding</span></div></div>
      <p>Loading...</p>
    </>
  )

  if (done) {
    return (
      <>
        <div className="topbar">
          <div className="crumbs"><span className="now">Onboarding</span></div>
        </div>
        <p className="eyebrow">ALL SET</p>
        <h1>You&rsquo;re onboarded</h1>
        <p className="subtle">Your account is ready. You can now submit receipts and view invoices.</p>
        <a href="/portal/program" style={{
          display: 'inline-block', marginTop: 16, padding: '10px 24px',
          background: 'var(--bl-blue)', color: '#fff', borderRadius: 8,
          fontWeight: 600, fontSize: 14, textDecoration: 'none'
        }}>Go to Home</a>
      </>
    )
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">Onboarding</span></div>
      </div>

      <div style={{ maxWidth: 680 }}>
        <p className="eyebrow">WELCOME TO BUD LIGHT U</p>
        <h1>Set up your account</h1>
        <p className="subtle">Takes about 3 minutes. Your banking info is encrypted before it&rsquo;s stored.</p>
        <p className="muted" style={{ fontSize: 13 }}>Signed in as <strong>{userEmail}</strong></p>

        <div className="surface" style={{ marginTop: 16 }}>
          <div className="surface-header"><span className="surface-title">How this works</span></div>
          <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li style={{ fontSize: 13, color: 'var(--midgray)' }}>
              <strong style={{ color: 'var(--bl-navy)' }}>Fill in your details below</strong> : name, address, and banking info for direct deposit.
            </li>
            <li style={{ fontSize: 13, color: 'var(--midgray)' }}>
              <strong style={{ color: 'var(--bl-navy)' }}>Upload your Bud Light receipts</strong> by the 15th each month to get reimbursed up to $150.
            </li>
            <li style={{ fontSize: 13, color: 'var(--midgray)' }}>
              <strong style={{ color: 'var(--bl-navy)' }}>Your draft invoice is prepared automatically</strong> on the {INVOICE_GENERATE_DAY}th. Payment is via direct deposit (net-15) after it is sent to AP.
            </li>
          </ol>
        </div>

        <div style={{
          marginTop: 12, padding: '10px 14px', borderRadius: 8,
          background: 'rgba(180,83,9,0.06)', border: '1px solid rgba(180,83,9,0.12)',
          fontSize: 13, lineHeight: 1.6, color: 'var(--bl-navy)'
        }}>
          <strong style={{ color: '#b45309' }}>Using a work email?</strong>
          <p style={{ margin: '4px 0 6px' }}>
            Company spam filters often block our emails. Add these two senders
            to your safe list:
          </p>
          <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>
            <li><strong style={{ color: '#b45309' }}>noreply@budlightu.com</strong></li>
            <li><strong style={{ color: '#b45309' }}>onboarding@budlightu.com</strong></li>
          </ul>
          <p style={{ margin: 0, fontSize: 12 }}>
            In Outlook: Settings &rarr; Mail &rarr; Junk email &rarr; Safe senders
          </p>
        </div>

        <div className="stack" style={{ marginTop: 20 }}>
          <div className="surface">
            <h2 style={{ marginTop: 0, fontSize: 14 }}>Personal information</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field"><label>First name</label><input value={form.first_name} onChange={e => setForm({...form, first_name: e.target.value})} style={fieldErrors.first_name ? errStyle : {}} />{fieldErrors.first_name && <span className="field-err">{fieldErrors.first_name}</span>}</div>
              <div className="field"><label>Last name</label><input value={form.last_name} onChange={e => setForm({...form, last_name: e.target.value})} style={fieldErrors.last_name ? errStyle : {}} />{fieldErrors.last_name && <span className="field-err">{fieldErrors.last_name}</span>}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field"><label>Phone</label><input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} placeholder="647-555-0100" style={fieldErrors.phone ? errStyle : {}} />{fieldErrors.phone && <span className="field-err">{fieldErrors.phone}</span>}</div>
              <div className="field"><label>School / campus</label><input value={form.school_id} onChange={e => setForm({...form, school_id: e.target.value})} style={fieldErrors.school_id ? errStyle : {}} />{fieldErrors.school_id && <span className="field-err">{fieldErrors.school_id}</span>}</div>
            </div>
            <div className="field"><label>Street address</label><input value={form.street} onChange={e => setForm({...form, street: e.target.value})} style={fieldErrors.street ? errStyle : {}} />{fieldErrors.street && <span className="field-err">{fieldErrors.street}</span>}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
              <div className="field"><label>City</label><input value={form.city} onChange={e => setForm({...form, city: e.target.value})} style={fieldErrors.city ? errStyle : {}} />{fieldErrors.city && <span className="field-err">{fieldErrors.city}</span>}</div>
              <div className="field"><label>Province</label><select value={form.prov} onChange={e => setForm({...form, prov: e.target.value})} style={fieldErrors.prov ? errStyle : {}}><option value="">Select...</option>{PROVINCE_CODES.map(p => <option key={p} value={p}>{p}</option>)}</select>{fieldErrors.prov && <span className="field-err">{fieldErrors.prov}</span>}</div>
              <div className="field"><label>Postal code</label><input value={form.postal} onChange={e => setForm({...form, postal: e.target.value})} placeholder="M5V 3L9" style={fieldErrors.postal ? errStyle : {}} />{fieldErrors.postal && <span className="field-err">{fieldErrors.postal}</span>}</div>
            </div>
          </div>

          <div className="surface">
            <h2 style={{ marginTop: 0, fontSize: 14 }}>Direct deposit</h2>
            <p className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 12 }}>Encrypted at rest. Only Salt&rsquo;s payment system can decrypt.</p>
            {/* Sits under the account fields on purpose: this is a statement about the
                numbers immediately above it, and it reads as nonsense anywhere else. */}
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
              <label>Bank</label>
              <select value={form.bank_name} onChange={e => setForm({...form, bank_name: e.target.value})} style={fieldErrors.bank_name ? errStyle : {}}>
                <option value="">Select...</option>
                {BANK_SEED.map(b => <option key={b.normalized} value={b.displayName}>{b.displayName}</option>)}
                <option value="Other">Other (type your bank name)</option>
              </select>
              {fieldErrors.bank_name && <span className="field-err">{fieldErrors.bank_name}</span>}
            </div>
            {form.bank_name === 'Other' && (
              <div className="field">
                <label>Your bank name</label>
                <input
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
              <div className="field"><label>Institution #</label><input inputMode="numeric" maxLength={3} placeholder="3 digits" value={form.institution_no} onChange={e => setForm({...form, institution_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.institution_no ? errStyle : {}} />{fieldErrors.institution_no && <span className="field-err">{fieldErrors.institution_no}</span>}</div>
              <div className="field"><label>Transit #</label><input inputMode="numeric" maxLength={5} placeholder="5 digits" value={form.transit_no} onChange={e => setForm({...form, transit_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.transit_no ? errStyle : {}} />{fieldErrors.transit_no && <span className="field-err">{fieldErrors.transit_no}</span>}</div>
              <div className="field"><label>Account #</label><input inputMode="numeric" value={form.account_no} onChange={e => setForm({...form, account_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.account_no ? errStyle : {}} />{fieldErrors.account_no && <span className="field-err">{fieldErrors.account_no}</span>}</div>
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
                    <label>{HST_COPY.numberLabel}</label>
                    <input
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
              <span style={{ fontSize: 13, color: 'var(--midgray)', lineHeight: 1.5 }}>
                I agree to the{' '}
                <a href="/portal/terms" target="_blank" rel="noopener noreferrer">Bud Light U program terms</a>
                {' '}(opens in a new tab). Submitting fraudulent, reused, or AI-generated receipts may result in forfeiture of reimbursement and removal from the program. I will retain original receipts for at least 6 months.
              </span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.consent_ap_cc} onChange={e => setForm({...form, consent_ap_cc: e.target.checked})} style={{ width: 'auto', marginTop: 3, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--midgray)', lineHeight: 1.5 }}>
                I consent to Salt XC processing my banking information for paying my monthly BAM invoice.
              </span>
            </label>

            {/* Nothing in the signed BAM contract covers work authorisation, and a study
                permit's off-campus allowance generally does not extend to self-employment.
                Shane Deen, 2026-08-27, called this the highest-value new attestation. */}
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.work_auth} onChange={e => setForm({...form, work_auth: e.target.checked})} style={{ width: 'auto', marginTop: 3, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--midgray)', lineHeight: 1.5 }}>
                {WORK_AUTH_COPY.checkbox}
                <span style={{ display: 'block', fontSize: 11, marginTop: 3 }}>{WORK_AUTH_COPY.help}</span>
              </span>
            </label>
          </div>

          {/* Kept out of the block above, and out of the program terms, because it is the
              one thing here that can be refused. Bundling refusable consent into terms
              somebody must accept to get paid is how consent stops meaning anything. */}
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

          <button onClick={submitForm} disabled={busy || !form.consent_ap_cc || !form.consent_terms || !form.hst_attested
            || !form.work_auth || !form.banking_owner
            || form.hst_status === ''
            || (form.hst_status === 'registered' && !form.hst_number.trim())}>
            {busy ? 'Submitting...' : 'Finish onboarding'}
          </button>
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
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => setInstitutionAsk(null)}>
                  Let me fix it
                </button>
              </div>
            </div>
          )}
          {error && <p style={{ color: '#A31212', fontSize: 14 }}>{error}</p>}
        </div>
      </div>
    </>
  )
}
