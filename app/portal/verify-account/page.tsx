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
import { resolveBamId } from '@/lib/portal-bam'

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
      const bamId = await resolveBamId(sb, userRes.user)
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

  if (err) {
    // Says what happened, then what to do. "Not logged in." alone left a student on a page with no way out.
    const signedOut = err === 'Not logged in.'
    return (
      <main className="container" style={{ maxWidth: 520 }}>
        <h1>{signedOut ? 'Please sign in again' : 'We could not open this page'}</h1>
        <p className="subtle">
          {signedOut
            ? 'Your sign-in has ended or this link was opened in a different browser. Sign in again to confirm your account.'
            : `${err} Sign in again, and if it keeps happening, contact your program manager.`}
        </p>
        <p><a href="/portal/login" className="btn">Sign in</a></p>
      </main>
    )
  }
  if (phase === 'loading') return <main className="container"><p className="muted">Loading…</p></main>
  if (phase === 'done')    return <main className="container"><h1>Verified ✓</h1><p className="subtle">Redirecting…</p></main>

  return (
    <main className="container" style={{ maxWidth: 520 }}>
      <p className="eyebrow">FIRST LOGIN · VERIFY</p>
      <h1>Confirm your account</h1>
      <p className="subtle">
        Before we send anything with your banking info, let&rsquo;s make sure this is really you.
      </p>

      {/*
        The last 4 digits are the entire point of this screen, so they get the
        strongest contrast on the page. They used to be rendered in var(--bl-blue)
        on a .hero-card whose background is also var(--bl-blue), i.e. invisible,
        which silently defeated the P0-4 check: the student confirmed without ever
        seeing the number they were confirming.
      */}
      <div className="hero-card" style={{ marginTop: 20 }}>
        <div style={{
          fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em',
          marginBottom: 10, color: 'rgba(255,255,255,0.85)'
        }}>
          Your account on file
        </div>

        <div style={{ fontSize: 17, fontWeight: 600, color: '#fff', marginBottom: 10 }}>
          {bank ?? 'Bank not set'}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.85)' }}>Account ending in</span>
          <span style={{
            fontFamily: 'monospace', fontSize: 30, fontWeight: 700, letterSpacing: '0.12em',
            color: 'var(--bl-navy)', background: '#fff',
            padding: '4px 14px', borderRadius: 8, lineHeight: 1.25
          }}>
            {tail ?? '••••'}
          </span>
        </div>
      </div>

      <div style={{
        marginTop: 12, padding: '12px 14px', borderRadius: 10,
        background: 'rgba(163,18,18,0.06)', border: '1px solid rgba(163,18,18,0.25)',
        fontSize: 13, lineHeight: 1.6
      }}>
        <strong style={{ color: '#A31212' }}>Do these 4 digits match your own bank account?</strong>
        <p style={{ margin: '4px 0 0' }}>
          If they do not, <strong>do not confirm</strong>. Pick whichever of the two options below
          matches your situation.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
        <button onClick={confirm}>Yes, that&rsquo;s my account. Confirm</button>

        {/*
          Two distinct exits, because they are two different problems.

          1. A typo: the student mistyped their own digits. That is a routine
             correction, so it goes through the tracked request flow at
             /portal/account, where Robin applies it and it is audited.
          2. Someone else filled in the form: that is a security incident, not a
             typo. It needs a human immediately and it must NOT look like a normal
             self-service correction, so it stays a direct email.

          The old single "These are not my details" button sent both cases to the
          same mailto and recorded neither.
        */}
        <a href="/portal/account" className="btn-ghost" style={{ textDecoration: 'none', padding: '9px 16px' }}>
          I mistyped my details. Request a fix
        </a>
      </div>

      <div style={{ marginTop: 14, fontSize: 12.5, lineHeight: 1.7 }}>
        <a
          href={`mailto:robin.graham@ilovesalt.com?subject=${encodeURIComponent('Bud Light U - possible wrong person on my account')}&body=${encodeURIComponent(
            `Hi Robin,\n\nThe banking details on my Bud Light U account are not mine and I did not enter them.\n\n` +
            `Shown to me: ${bank ?? 'bank not set'}, account ending in ${tail ?? '????'}\n` +
            `My account actually ends in: \n\n` +
            `Please do not send anything until this is sorted out.\n\nThanks`
          )}`}
          style={{ color: '#A31212', fontWeight: 600 }}
        >
          These digits are not mine and I did not enter them
        </a>
        <span className="muted"> (someone else may have filled in your onboarding form: email your program manager now)</span>
      </div>

      <p className="subtle" style={{ fontSize: 12, marginTop: 14 }}>
        Banking details cannot be changed from the portal. Robin applies the change for you, so that a
        payment can never be redirected by someone who gets into your account.
      </p>
    </main>
  )
}
