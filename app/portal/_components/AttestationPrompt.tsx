'use client'
/**
 * Asks the three setup statements of anyone who onboarded before we asked them.
 *
 * Everyone from 2026-09-02 answers these on the onboarding form. Three students
 * finished onboarding earlier, and without this they would never be asked at all.
 * Rather than a second onboarding pass, they get the questions once, on the dashboard,
 * the next time they sign in.
 *
 * It has no close button. These are statements the program needs on file, and a dialog
 * you can wave away is a dialog nobody answers. It is not a lockout either: the sidebar
 * still works, and "Not sure?" goes to support. Someone who cannot honestly tick the
 * work-authorisation box leaves and asks, which is the outcome Shane wanted ("flag any
 * unsure response to a human queue and pause engagement") rather than a student clicking
 * yes to make a box go away.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { WORK_AUTH_COPY, BANKING_ATTESTATION_COPY, AI_DISCLOSURE_COPY } from '@/lib/attestations'

export function AttestationPrompt() {
  const [show, setShow] = useState(false)
  const [askAiTraining, setAskAiTraining] = useState(false)
  const [workAuth, setWorkAuth] = useState(false)
  const [bankingOwner, setBankingOwner] = useState(false)
  const [aiTraining, setAiTraining] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/portal/attestations')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        setShow(j?.needed === true)
        setAskAiTraining(j?.askAiTraining === true)
      })
      // A failed check shows nothing. See the GET handler: not asking is the safe
      // direction, because the question comes back next visit anyway.
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!show) return null

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/portal/attestations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_auth: workAuth,
          banking_owner: bankingOwner,
          // Only sent when the question was actually put to them, so a screen that never
          // showed the box cannot record a "no".
          ...(askAiTraining ? { ai_training: aiTraining } : {})
        })
      })
      const j = await res.json()
      if (!res.ok || !j.ok) {
        setError(j?.message || 'Could not save that. Try again.')
        return
      }
      setShow(false)
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="attest-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0, 12, 32, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        overflowY: 'auto'
      }}
    >
      <div className="surface" style={{ maxWidth: 480, width: '100%', margin: 'auto' }}>
        <div className="surface-header">
          <span className="surface-title" id="attest-title">Two things to confirm</span>
        </div>

        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          We added these after you set up your account.
        </p>

        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer', marginTop: 14 }}>
          <input
            type="checkbox"
            checked={workAuth}
            onChange={e => setWorkAuth(e.target.checked)}
            style={{ width: 'auto', marginTop: 3, flexShrink: 0 }}
          />
          <span>
            {WORK_AUTH_COPY.checkbox}
            <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 3 }}>
              {WORK_AUTH_COPY.help}
            </span>
          </span>
        </label>

        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer', marginTop: 14 }}>
          <input
            type="checkbox"
            checked={bankingOwner}
            onChange={e => setBankingOwner(e.target.checked)}
            style={{ width: 'auto', marginTop: 3, flexShrink: 0 }}
          />
          <span>{BANKING_ATTESTATION_COPY.checkbox}</span>
        </label>

        {askAiTraining && (
          <div style={{ borderTop: '1px solid var(--stone)', marginTop: 16, paddingTop: 14 }}>
            <p style={{ fontSize: 13, margin: '0 0 8px', fontWeight: 600 }}>{AI_DISCLOSURE_COPY.trainingQuestion}</p>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={aiTraining}
                onChange={e => setAiTraining(e.target.checked)}
                style={{ width: 'auto', marginTop: 3, flexShrink: 0 }}
              />
              <span>
                {AI_DISCLOSURE_COPY.trainingCheckbox}
                <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 3 }}>
                  {AI_DISCLOSURE_COPY.trainingHelp}
                </span>
              </span>
            </label>
          </div>
        )}

        {error && (
          <p style={{ color: 'var(--red)', fontSize: 12, marginBottom: 0 }}>{error}</p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
          <button onClick={save} disabled={saving || !workAuth || !bankingOwner}>
            {saving ? 'Saving…' : 'Confirm'}
          </button>
          {/* The way out for anyone who cannot tick the first box honestly. */}
          <Link href="/portal/support" className="muted" style={{ fontSize: 12 }}>
            Not sure? Ask your program contact
          </Link>
        </div>
      </div>
    </div>
  )
}
