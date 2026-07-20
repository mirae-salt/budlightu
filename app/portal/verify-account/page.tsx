'use client'
/**
 * P0-4 first-login confirmation screen.
 *
 * On the student's first successful OTP login, redirect here. Shows the
 * last 4 of their account number so they can verify their onboarding
 * info wasn't sent to the wrong person. Confirming stamps bams.email_verified_at
 * and unlocks BAM copy sends (see supabase/functions/sendBamCopy).
 */
import { useEffect, useState } from 'react'
import { browserClient } from '@/lib/supabase-browser'

export default function VerifyAccountPage() {
  const [phase, setPhase] = useState<'loading' | 'confirm' | 'done'>('loading')
  const [tail, setTail] = useState<string | null>(null)
  const [bank, setBank] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      const sb = browserClient()
      const { data: userRes } = await sb.auth.getUser()
      if (!userRes.user) { setErr('Not logged in.'); return }
      const bamId = (userRes.user.user_metadata as { bam_id?: string }).bam_id
      if (!bamId) { setErr('No BAM record.'); return }

      // If already verified, skip
      const { data: bam } = await sb.from('bams').select('email_verified_at, bank_name').eq('id', bamId).single()
      if (bam?.email_verified_at) { window.location.href = '/portal/dashboard'; return }
      setBank(bam?.bank_name ?? null)

      // Ask server for banking tail (server decrypts via RPC; client never sees full account)
      const resp = await fetch('/api/verify-account/tail')
      if (!resp.ok) { setErr('Could not load account info.'); return }
      const j = await resp.json()
      setTail(j.tail)
      setPhase('confirm')
    })()
  }, [])

  async function confirm() {
    const resp = await fetch('/api/verify-account/confirm', { method: 'POST' })
    if (!resp.ok) { setErr('Confirmation failed.'); return }
    setPhase('done')
    setTimeout(() => { window.location.href = '/portal/dashboard' }, 1500)
  }

  if (err) return <main className="container"><h1>Something went wrong</h1><p className="subtle">{err}</p></main>
  if (phase === 'loading') return <main className="container"><p className="muted">Loading…</p></main>
  if (phase === 'done')    return <main className="container"><h1>Verified ✓</h1><p className="subtle">Redirecting…</p></main>

  return (
    <main className="container" style={{ maxWidth: 520 }}>
      <p className="eyebrow">FIRST LOGIN · VERIFY</p>
      <h1>Confirm your account</h1>
      <p className="subtle">
        Before we send anything with your banking info, let&rsquo;s make sure this is really you.
      </p>

      <div className="hero-card" style={{ marginTop: 20 }}>
        <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Your account on file
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--bl-navy)', fontFamily: 'monospace' }}>
          {bank ?? '—'} · ending in <span style={{ color: 'var(--bl-blue)' }}>{tail ?? '••••'}</span>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
          If those last 4 digits don&rsquo;t match your bank account, <strong>do NOT confirm</strong> — email
          robin.graham@ilovesalt.com immediately. Someone else may have completed your onboarding form.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button onClick={confirm}>Yes, that&rsquo;s me — confirm</button>
        <a href="mailto:robin.graham@ilovesalt.com?subject=BLU%20account%20verification%20issue" className="btn-ghost" style={{ textDecoration: 'none', padding: '9px 16px' }}>
          Something&rsquo;s wrong
        </a>
      </div>
    </main>
  )
}
