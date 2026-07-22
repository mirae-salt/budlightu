'use client'
import { useState, use } from 'react'
import { BANK_SEED } from '@/lib/banks'

/**
 * Onboarding form — invite-token gated (P0-3).
 * Two-step: (1) email confirm, (2) banking details.
 * Banking fields only rendered after step 1 passes.
 */
export default function OnboardingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [email, setEmail] = useState('')
  const [form, setForm] = useState({
    first_name: '', last_name: '', phone: '',
    street: '', city: '', prov: '', postal: '', school_id: '',
    bank_name: '', institution_no: '', transit_no: '', account_no: '',
    hst_number: '', consent_ap_cc: true
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function submitAll() {
    setBusy(true); setError(null)
    try {
      const resp = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invite_token: token, form: { ...form, email } })
      })
      const j = await resp.json()
      if (!resp.ok || !j.ok) { setError(j.message ?? 'Failed'); setBusy(false); return }
      setDone(j.message)
      setStep(3)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (step === 3 && done) {
    return (
      <main className="container" style={{ maxWidth: 560 }}>
        <p className="eyebrow">ALL SET</p>
        <h1>You&rsquo;re onboarded 🎉</h1>
        <p className="subtle">{done}</p>
        <p className="subtle">
          <a href="/portal/login" style={{ color: 'var(--teal-sub)' }}>Sign in →</a>
        </p>
      </main>
    )
  }

  return (
    <main className="container" style={{ maxWidth: 560 }}>
      <p className="eyebrow">WELCOME TO BUD LIGHT U</p>
      <h1>Set up your account</h1>
      <p className="subtle">Takes about 3 minutes. Your banking info is encrypted before it&rsquo;s stored.</p>

      {/* Step 1: email confirm */}
      {step === 1 && (
        <div className="hero-card stack" style={{ marginTop: 24 }}>
          <div className="field">
            <label>Confirm your email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@school.edu" />
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Must match the address your program manager invited.</p>
          </div>
          <button onClick={() => setStep(2)} disabled={!email.includes('@')}>Continue</button>
        </div>
      )}

      {/* Step 2: full form */}
      {step === 2 && (
        <div className="stack" style={{ marginTop: 24 }}>

          <div className="hero-card">
            <h2 style={{ marginTop: 0 }}>You</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field"><label>Legal first name</label><input value={form.first_name} onChange={e => setForm({...form, first_name: e.target.value})} /></div>
              <div className="field"><label>Legal last name</label><input value={form.last_name} onChange={e => setForm({...form, last_name: e.target.value})} /></div>
            </div>
            <div className="field"><label>Phone</label><input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} placeholder="647-555-0100" /></div>
            <div className="field"><label>Street</label><input value={form.street} onChange={e => setForm({...form, street: e.target.value})} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
              <div className="field"><label>City</label><input value={form.city} onChange={e => setForm({...form, city: e.target.value})} /></div>
              <div className="field"><label>Province</label><input value={form.prov} onChange={e => setForm({...form, prov: e.target.value})} placeholder="ON" /></div>
              <div className="field"><label>Postal</label><input value={form.postal} onChange={e => setForm({...form, postal: e.target.value})} placeholder="M5V 3L9" /></div>
            </div>
            <div className="field"><label>School / campus</label><input value={form.school_id} onChange={e => setForm({...form, school_id: e.target.value})} /></div>
          </div>

          <div className="hero-card">
            <h2 style={{ marginTop: 0 }}>Direct deposit</h2>
            <p className="subtle" style={{ fontSize: 13, marginTop: 0 }}>These fields are encrypted at rest. Only Salt&rsquo;s payment system can decrypt.</p>
            <div className="field">
              <label>Bank</label>
              <select value={form.bank_name} onChange={e => setForm({...form, bank_name: e.target.value})}>
                <option value="">Select…</option>
                {BANK_SEED.map(b => <option key={b.normalized} value={b.displayName}>{b.displayName}</option>)}
                <option value="Other">Other (contact your program manager)</option>
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 12 }}>
              <div className="field"><label>Institution # (3 digits)</label><input inputMode="numeric" maxLength={3} value={form.institution_no} onChange={e => setForm({...form, institution_no: e.target.value.replace(/\D/g,'')})} /></div>
              <div className="field"><label>Transit # (5 digits)</label><input inputMode="numeric" maxLength={5} value={form.transit_no} onChange={e => setForm({...form, transit_no: e.target.value.replace(/\D/g,'')})} /></div>
              <div className="field"><label>Account #</label><input inputMode="numeric" value={form.account_no} onChange={e => setForm({...form, account_no: e.target.value.replace(/\D/g,'')})} /></div>
            </div>
            <div className="field"><label>HST number (optional)</label><input value={form.hst_number} onChange={e => setForm({...form, hst_number: e.target.value})} placeholder="123456789 RT 0001" /></div>
          </div>

          <div className="card">
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.consent_ap_cc} onChange={e => setForm({...form, consent_ap_cc: e.target.checked})} style={{ width: 'auto', marginTop: 2 }} />
              <span className="subtle" style={{ fontWeight: 400 }}>
                I consent to Salt XC processing my banking information for the sole purpose of paying my monthly BAM invoice.
              </span>
            </label>
          </div>

          <button onClick={submitAll} disabled={busy || !form.consent_ap_cc}>
            {busy ? 'Submitting…' : 'Finish onboarding'}
          </button>
          {error && <p style={{ color: '#A31212' }}>{error}</p>}
        </div>
      )}
    </main>
  )
}
