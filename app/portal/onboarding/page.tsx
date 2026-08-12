'use client'
import { useState, useEffect } from 'react'
import { browserClient } from '@/lib/supabase-browser'
import { BANK_SEED } from '@/lib/banks'
// Free text here let a student type "Ontario", which computeHst() throws on at invoice
// time. The list is derived from the tax table itself, so the two cannot drift.
import { PROVINCE_CODES } from '@/lib/invoice-payload'

export default function OnboardingPage() {
  const [loading, setLoading] = useState(true)
  const [bamId, setBamId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [form, setForm] = useState({
    first_name: '', last_name: '', phone: '',
    street: '', city: '', prov: '', postal: '', school_id: '',
    bank_name: '', institution_no: '', transit_no: '', account_no: '',
    hst_number: '', consent_ap_cc: true, consent_terms: false
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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

    setBusy(true); setError(null)
    try {
      const resp = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ form: { ...form, email: userEmail } })
      })
      const j = await resp.json()
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
              <strong style={{ color: 'var(--bl-navy)' }}>Your invoice generates automatically</strong> on the 16th. Payment is via direct deposit (net-15).
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
            <div className="field">
              <label>Bank</label>
              <select value={form.bank_name} onChange={e => setForm({...form, bank_name: e.target.value})} style={fieldErrors.bank_name ? errStyle : {}}>
                <option value="">Select...</option>
                {BANK_SEED.map(b => <option key={b.normalized} value={b.displayName}>{b.displayName}</option>)}
                <option value="Other">Other (contact your program manager)</option>
              </select>
              {fieldErrors.bank_name && <span className="field-err">{fieldErrors.bank_name}</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 12 }}>
              <div className="field"><label>Institution #</label><input inputMode="numeric" maxLength={3} placeholder="3 digits" value={form.institution_no} onChange={e => setForm({...form, institution_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.institution_no ? errStyle : {}} />{fieldErrors.institution_no && <span className="field-err">{fieldErrors.institution_no}</span>}</div>
              <div className="field"><label>Transit #</label><input inputMode="numeric" maxLength={5} placeholder="5 digits" value={form.transit_no} onChange={e => setForm({...form, transit_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.transit_no ? errStyle : {}} />{fieldErrors.transit_no && <span className="field-err">{fieldErrors.transit_no}</span>}</div>
              <div className="field"><label>Account #</label><input inputMode="numeric" value={form.account_no} onChange={e => setForm({...form, account_no: e.target.value.replace(/\D/g,'')})} style={fieldErrors.account_no ? errStyle : {}} />{fieldErrors.account_no && <span className="field-err">{fieldErrors.account_no}</span>}</div>
            </div>
            <div className="field"><label>HST number <span style={{ fontWeight: 400, color: 'var(--midgray)' }}>(optional)</span></label><input value={form.hst_number} onChange={e => setForm({...form, hst_number: e.target.value})} placeholder="123456789 RT 0001" /></div>
          </div>

          <div className="surface" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
          </div>

          <button onClick={submitForm} disabled={busy || !form.consent_ap_cc || !form.consent_terms}>
            {busy ? 'Submitting...' : 'Finish onboarding'}
          </button>
          {error && <p style={{ color: '#A31212', fontSize: 14 }}>{error}</p>}
        </div>
      </div>
    </>
  )
}
