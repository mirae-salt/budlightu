'use client'
/**
 * /portal/account — the BAM's banking details, and the only way to get them fixed.
 *
 * A BAM cannot edit banking here. Nothing on this page writes to their record.
 * The form files a REQUEST that a program manager applies by hand, because a
 * portal that lets an account holder rewrite their own payout destination lets
 * whoever steals that account rewrite it too.
 */
import { useEffect, useState } from 'react'
import { BANK_SEED } from '@/lib/banks'
import { NotificationInfo } from './NotificationInfo'
import { MIN_REASON_LENGTH } from '@/lib/banking-request'

type PendingRequest = {
  id: string
  status: string
  reason: string
  bank_name: string
  requested_at: string
  decided_at: string | null
  decision_note: string | null
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for review',
  approved: 'Approved',
  rejected: 'Not applied',
  applied: 'Applied'
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'badge badge-yellow',
  approved: 'badge badge-blue',
  rejected: 'badge badge-red',
  applied: 'badge badge-green'
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const BANK_OPTIONS = [...BANK_SEED].sort((a, b) => a.displayName.localeCompare(b.displayName))

export default function AccountPage() {
  const [loading, setLoading] = useState(true)
  const [bankOnFile, setBankOnFile] = useState<string | null>(null)
  const [tail, setTail] = useState<string | null>(null)
  const [tailNote, setTailNote] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [history, setHistory] = useState<PendingRequest[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [bankName, setBankName] = useState('')
  const [institution, setInstitution] = useState('')
  const [transit, setTransit] = useState('')
  const [account, setAccount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function load() {
    setLoadError(null)
    try {
      const res = await fetch('/api/portal/banking-request')
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setLoadError(json.message ?? 'Could not load your account details.')
      } else {
        setBankOnFile(json.bank_name ?? null)
        setPending(json.pending ?? null)
        setHistory((json.history ?? []) as PendingRequest[])
      }
    } catch (e) {
      setLoadError((e as Error).message)
    }

    // Same endpoint the first-login check uses. The full account number is
    // decrypted server side and never sent to the browser.
    try {
      const t = await fetch('/api/verify-account/tail')
      if (t.ok) {
        const tj = await t.json()
        setTail(tj.tail ?? null)
      } else {
        const tj = await t.json().catch(() => ({}))
        setTailNote(tj.message ?? 'No banking details are on file yet.')
      }
    } catch {
      setTailNote('Could not load your account number.')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const digitsOnly = (s: string) => s.replace(/[^0-9]/g, '')

  /**
   * What is still missing, in words. The button used to be greyed out with no
   * explanation, so the only way to discover that the reason had a minimum was to
   * guess. A disabled control that will not say why is a dead end.
   */
  const missing: string[] = []
  if (bankName === '') missing.push('pick your bank')
  if (!/^\d{3}$/.test(institution)) missing.push('institution number needs 3 digits')
  if (!/^\d{5}$/.test(transit)) missing.push('transit number needs 5 digits')
  if (!/^\d{6,12}$/.test(account)) missing.push('account number needs 6 to 12 digits')
  if (reason.trim().length < MIN_REASON_LENGTH) missing.push('tell us why you need the change')
  const formReady = missing.length === 0

  async function submit() {
    setErr(null)
    setBusy(true)
    try {
      const res = await fetch('/api/portal/banking-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Strings, always. These never go near Number(): a dropped leading zero
        // is a payment into a different account.
        body: JSON.stringify({
          bank_name: bankName,
          institution_no: institution,
          transit_no: transit,
          account_no: account,
          reason
        })
      })
      const json = await res.json()
      if (!res.ok || !json.ok) { setErr(json.message ?? 'Something went wrong.'); return }
      setSent(true)
      setShowForm(false)
      setInstitution(''); setTransit(''); setAccount(''); setReason(''); setBankName('')
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">My account</span></div>
      </div>

      <div style={{ maxWidth: 680 }}>
        <h1>Banking details</h1>
        <p className="subtle">
          This is where your reimbursements and pay are sent. You cannot edit it here on purpose:
          if someone ever got into your account, they could point your pay at themselves.
          Ask for a correction and your program manager applies it.
        </p>

        {/*
          .hero-card's background IS var(--bl-blue). Text on it is white or navy
          on a white chip. Never var(--bl-blue) on this card: that made a critical
          number invisible once already (see /portal/verify-account).
        */}
        <div className="hero-card" style={{ marginTop: 20 }}>
          <div style={{
            fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em',
            marginBottom: 10, color: 'rgba(255,255,255,0.85)'
          }}>
            On file now
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, color: '#fff', marginBottom: 10 }}>
            {loading ? 'Loading...' : (bankOnFile ?? 'Bank not set')}
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
          {tailNote && !tail && (
            <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.85)', marginTop: 10 }}>{tailNote}</div>
          )}
        </div>

        {loadError && (
          <p style={{ color: '#A31212', marginTop: 16, fontSize: 13 }}>{loadError}</p>
        )}

        {sent && (
          <div className="badge badge-green" style={{ marginTop: 16, display: 'inline-block' }}>
            Request sent to your program manager
          </div>
        )}

        {/* ── An open request replaces the form. One at a time. ── */}
        {pending ? (
          <div className="surface" style={{ marginTop: 20 }}>
            <div className="surface-header">
              <div className="surface-title">Correction requested</div>
              <span className={STATUS_BADGE.pending}>{STATUS_LABEL.pending}</span>
            </div>
            <p style={{ fontSize: 13.5, lineHeight: 1.7, margin: '4px 0 0' }}>
              You asked for your details to be changed to <strong>{pending.bank_name}</strong> on{' '}
              {fmtDate(pending.requested_at)}. Your program manager reviews it by hand and confirms the
              account number before anything changes.
            </p>
            <p style={{ fontSize: 13, color: 'var(--midgray)', marginTop: 10 }}>
              Your reason: {pending.reason}
            </p>
            <p style={{ fontSize: 13, color: 'var(--midgray)', marginTop: 10 }}>
              You can only have one request open at a time. If you made a mistake in it, use Support
              and ask for it to be cancelled.
            </p>
          </div>
        ) : (
          <div className="surface" style={{ marginTop: 20 }}>
            <div className="surface-header">
              <div className="surface-title">Something wrong with these details?</div>
            </div>

            {!showForm ? (
              <>
                <p style={{ fontSize: 13.5, lineHeight: 1.7, margin: '4px 0 14px' }}>
                  If you mistyped a digit during onboarding, or you changed banks, request a correction.
                  Nothing changes until your program manager applies it, and you will be asked to confirm
                  the new last 4 digits afterwards.
                </p>
                <button onClick={() => setShowForm(true)}>Request a correction</button>
              </>
            ) : (
              <div className="stack">
                <div className="field">
                  <label htmlFor="bank">Bank</label>
                  <select id="bank" value={bankName} onChange={e => setBankName(e.target.value)}>
                    <option value="">Choose your bank</option>
                    {BANK_OPTIONS.map(b => (
                      <option key={`${b.normalized}-${b.displayName}`} value={b.displayName}>{b.displayName}</option>
                    ))}
                  </select>
                  <span className="field-err" style={{ color: 'var(--midgray)', fontWeight: 400 }}>
                    Not listed? Use Support so it can be added. We never guess a bank.
                  </span>
                </div>

                <div className="field">
                  <label htmlFor="institution">Institution number (3 digits)</label>
                  <input
                    id="institution" inputMode="numeric" autoComplete="off" maxLength={3}
                    value={institution} onChange={e => setInstitution(digitsOnly(e.target.value))}
                    placeholder="003"
                  />
                </div>

                <div className="field">
                  <label htmlFor="transit">Transit number (5 digits)</label>
                  <input
                    id="transit" inputMode="numeric" autoComplete="off" maxLength={5}
                    value={transit} onChange={e => setTransit(digitsOnly(e.target.value))}
                    placeholder="05162"
                  />
                </div>

                <div className="field">
                  <label htmlFor="account">Account number (6 to 12 digits)</label>
                  <input
                    id="account" inputMode="numeric" autoComplete="off" maxLength={12}
                    value={account} onChange={e => setAccount(digitsOnly(e.target.value))}
                    placeholder="0001234567"
                  />
                  <span className="field-err" style={{ color: 'var(--midgray)', fontWeight: 400 }}>
                    Copy it exactly off your void cheque or direct deposit form, including any leading zeros.
                  </span>
                </div>

                <div className="field">
                  <label htmlFor="reason">Why do you need this change?</label>
                  <textarea
                    id="reason" rows={3} value={reason} onChange={e => setReason(e.target.value)}
                    placeholder="For example: I typed my account number wrong during onboarding."
                  />
                </div>

                <div style={{
                  padding: '12px 14px', borderRadius: 10,
                  background: 'rgba(58,173,217,0.08)', border: '1px solid rgba(58,173,217,0.3)',
                  fontSize: 13, lineHeight: 1.6
                }}>
                  <strong>What happens next.</strong> Your program manager applies this by hand. After it is
                  applied you will be asked to sign in and confirm the new last 4 digits, so nobody can
                  change where your pay goes without you seeing it.
                </div>

                {!formReady && (
                  <p className="muted" style={{ fontSize: 12.5, margin: '0 0 4px' }}>
                    Still needed: {missing.join(' · ')}
                  </p>
                )}

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={submit}
                    disabled={busy || !formReady}
                    title={formReady ? undefined : `Still needed: ${missing.join(', ')}`}
                  >
                    {busy ? 'Sending...' : 'Send request'}
                  </button>
                  <button className="btn-ghost" onClick={() => { setShowForm(false); setErr(null) }}>Cancel</button>
                </div>
                {err && <p style={{ color: '#A31212', fontSize: 13, margin: 0 }}>{err}</p>}
              </div>
            )}
          </div>
        )}

        {history.filter(h => h.status !== 'pending').length > 0 && (
          <div className="surface" style={{ marginTop: 20 }}>
            <div className="surface-header">
              <div className="surface-title">Past requests</div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="admin-table">
                <thead>
                  <tr><th>Requested</th><th>Bank</th><th>Result</th><th>Note</th></tr>
                </thead>
                <tbody>
                  {history.filter(h => h.status !== 'pending').map(h => (
                    <tr key={h.id}>
                      <td className="muted">{fmtDate(h.requested_at)}</td>
                      <td>{h.bank_name}</td>
                      <td><span className={STATUS_BADGE[h.status] ?? 'badge'}>{STATUS_LABEL[h.status] ?? h.status}</span></td>
                      <td className="muted" style={{ fontSize: 12.5 }}>{h.decision_note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <NotificationInfo />
      </div>
    </>
  )
}
