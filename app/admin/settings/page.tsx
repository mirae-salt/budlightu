/**
 * /admin/settings — one place for the settings that used to be scattered.
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * Notification settings were spread across three places and an environment variable:
 * frequency on the Questions page, maintenance mode on its own page, who receives support
 * questions in SUPPORT_NOTIFY_EMAIL, and who is copied on invoices in AP_CC_EMAILS. The two
 * env vars are the real problem: changing who gets an email meant a Vercel edit and a
 * redeploy, which meant asking Mirae, which meant it did not happen.
 *
 * Invoice email routing is EDITABLE here as of 2026-08-13. It reads through
 * lib/ap-addresses.ts: the `policy` row first, the environment as the fallback, so the Edge
 * Function keeps working before the row exists. Mirae's point was that Robin is the admin and
 * owns that risk, and "ask Mirae" stops working the day Mirae leaves. The write is super-admin
 * only, refuses a malformed address instead of storing it, reads the row back through the same
 * resolver the senders use, and writes an audit entry with both sides.
 *
 * WHAT IS PER-ADMIN AND WHAT IS SHARED
 * ------------------------------------
 * Frequency is per admin and only the viewer can change their own. This page shows
 * everyone's so Robin can answer "is Nathan getting these?" without asking Nathan, but the
 * other rows are text, not controls. One person quietly muting another person's alerts
 * about a student waiting for an answer is the bug this was rewritten to prevent.
 *
 * WHAT WAS REMOVED
 * ----------------
 * A shared "copy someone who is not an admin" list. Mirae asked twice what it was for, which is
 * the answer: a setting whose owner cannot tell what it does is not a setting, it is a thing to
 * get wrong. Every admin already controls their own frequency, and a non-admin who needs to see
 * questions can be made an admin. lib/question-notify.ts still READS extraRecipients so a value
 * stored before this keeps working, but nothing can write one.
 */
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  QUESTION_NOTIFY_OPTIONS,
  type QuestionNotifyMode
} from '@/lib/question-notify'

type AdminRow = { email: string; mode: string }

type NotifyState = {
  mine: QuestionNotifyMode
  admins: AdminRow[]
  adminsError: string | null
  degraded: boolean
}

type ReminderState = {
  mode: 'off' | 'draft' | 'live'
  days: number[]
  degraded: boolean
  preview: { subject: string; html: string } | null
}

type InvoiceEmail = {
  /** Null when the setting could not be resolved. The problems array says why. */
  to: string | null
  cc: string[]
  from: string | null
  replyTo: string | null
  /** 'policy' means somebody set it here, 'env' means it is still the deployed default. */
  source: 'policy' | 'env' | null
  problems: string[]
}

const MODE_LABEL: Record<string, string> = {
  each: 'Every question',
  daily: 'Once a day',
  off: 'No emails'
}

export default function SettingsPage() {
  const [notify, setNotify] = useState<NotifyState | null>(null)
  const [invoice, setInvoice] = useState<InvoiceEmail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [savingMode, setSavingMode] = useState(false)
  const [modeMsg, setModeMsg] = useState<string | null>(null)

  // The AP address editor. Kept as raw text while it is being typed, so a half-finished
  // address is never handed to the validator and reported as broken mid-keystroke.
  const [editingAp, setEditingAp] = useState(false)
  const [apTo, setApTo] = useState('')
  const [apCc, setApCc] = useState('')
  const [savingAp, setSavingAp] = useState(false)
  const [apMsg, setApMsg] = useState<{ ok: boolean; text: string; problems?: string[] } | null>(null)

  const [reminders, setReminders] = useState<ReminderState | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [reminderMsg, setReminderMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [savingReminders, setSavingReminders] = useState(false)

  async function load() {
    try {
      const [nRes, iRes, rRes] = await Promise.all([
        fetch('/api/admin/question-notify'),
        fetch('/api/admin/settings'),
        fetch('/api/admin/student-reminders')
      ])
      const n = await nRes.json()
      if (!nRes.ok || !n?.ok) {
        setLoadError(n?.message ?? 'Could not load notification settings.')
      } else {
        setNotify({
          mine: n.setting?.mode ?? 'each',
          admins: Array.isArray(n.admins) ? n.admins : [],
          adminsError: n.adminsError ?? null,
          degraded: Boolean(n.degraded)
        })
      }

      const i = await iRes.json()
      if (iRes.ok && i?.ok) setInvoice(i.invoiceEmail)

      const r = await rRes.json()
      if (rRes.ok && r?.ok) {
        setReminders({
          mode: r.settings?.mode ?? 'off',
          days: Array.isArray(r.settings?.days) ? r.settings.days : [],
          degraded: Boolean(r.degraded),
          preview: r.preview ?? null
        })
      }
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }

  useEffect(() => { void load() }, [])

  /**
   * Save the AP addresses.
   *
   * Reads the response. An unchecked fetch here would make a refused write look exactly like a
   * successful one, which on this particular form means believing the invoice address changed
   * when it did not. The server validates, refuses a bad address and reads the row back, so
   * everything below is reporting what it said rather than assuming.
   */
  async function saveApAddresses() {
    setSavingAp(true)
    setApMsg(null)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: apTo, cc: apCc })
      })
      const j = await res.json().catch(() => null)
      if (!res.ok || !j?.ok) {
        setApMsg({
          ok: false,
          text: j?.message ?? `That did not save (${res.status}).`,
          problems: Array.isArray(j?.problems) ? j.problems : undefined
        })
        return
      }
      // The values the SERVER read back, not the ones that were typed.
      setInvoice(prev => prev ? { ...prev, ...j.invoiceEmail } : prev)
      setEditingAp(false)
      setApMsg(null)
      // Reload so From and Replies to come back too; the PUT only returns what it changed.
      await load()
    } catch (e) {
      setApMsg({ ok: false, text: (e as Error).message })
    } finally {
      setSavingAp(false)
    }
  }

  async function saveMode(mode: QuestionNotifyMode) {
    setSavingMode(true)
    setModeMsg(null)
    try {
      const res = await fetch('/api/admin/question-notify', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      })
      const j = await res.json()
      if (!res.ok || !j?.ok) {
        setModeMsg(j?.message ?? 'Not saved.')
      } else {
        // Reload rather than trusting the local value: the row shown for this admin in the
        // table below has to match what the server actually stored.
        await load()
        const chosen = QUESTION_NOTIFY_OPTIONS.find(o => o.mode === j.setting.mode)
        setModeMsg(`Saved. ${chosen?.label ?? j.setting.mode}.`)
      }
    } catch (e) {
      setModeMsg((e as Error).message)
    } finally {
      setSavingMode(false)
    }
  }

  async function saveReminders(mode: 'off' | 'draft' | 'live') {
    setSavingReminders(true)
    setReminderMsg(null)
    try {
      const res = await fetch('/api/admin/student-reminders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, days: reminders?.days ?? [10, 14] })
      })
      const j = await res.json()
      if (!res.ok || !j?.ok) {
        setReminderMsg({ ok: false, text: j?.message ?? 'Not saved.' })
      } else {
        setReminders(prev => (prev ? { ...prev, mode: j.settings.mode, degraded: false } : prev))
        setReminderMsg({
          ok: true,
          text: j.settings.mode === 'live'
            ? 'Saved. Reminders will be emailed to BAMs on the days listed.'
            : j.settings.mode === 'draft'
              ? 'Saved. Nothing will be emailed. The system will record who it would have emailed.'
              : 'Saved. No reminders will be sent.'
        })
      }
    } catch (e) {
      setReminderMsg({ ok: false, text: (e as Error).message })
    } finally {
      setSavingReminders(false)
    }
  }

  const eachAdmins = (notify?.admins ?? []).filter(a => a.mode === 'each')

  return (
    <div style={{ maxWidth: 780, padding: '32px 24px 64px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e', margin: '0 0 6px' }}>
        Settings
      </h1>
      <p style={{ fontSize: 14, color: '#6b7280', margin: '0 0 28px', lineHeight: 1.6 }}>
        Who gets emailed, and when. Changes take effect on the next question or invoice, with
        no deploy needed.
      </p>

      {loadError && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
          padding: 14, fontSize: 13, color: '#991b1b', marginBottom: 24
        }}>
          Could not load settings: {loadError}
        </div>
      )}

      {notify?.degraded && (
        <div style={{
          background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8,
          padding: 14, fontSize: 13, color: '#92400e', marginBottom: 24, lineHeight: 1.6
        }}>
          The saved settings could not be read, so this page is showing defaults. Questions
          are still being emailed to every admin, which is the safe direction. Reload in a
          moment.
        </div>
      )}

      {/* ---------------- Support questions ---------------- */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Support questions</h2>
        <p style={pStyle}>
          When a BAM asks a question from the portal. Every question is saved on the{' '}
          <Link href="/admin/questions" style={linkStyle}>Questions page</Link> regardless of
          what is set here.
        </p>

        <h3 style={h3Style}>How often you are emailed</h3>
        <p style={{ ...pStyle, marginBottom: 12 }}>
          Your setting only. Robin, Nathan and Mirae each choose their own.
        </p>

        <div style={{ display: 'grid', gap: 8 }}>
          {QUESTION_NOTIFY_OPTIONS.map(o => (
            <label
              key={o.mode}
              style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                border: `1px solid ${notify?.mine === o.mode ? '#0073cf' : '#e5e7eb'}`,
                background: notify?.mine === o.mode ? '#f0f7ff' : '#fff',
                borderRadius: 8, padding: '12px 14px', cursor: savingMode ? 'wait' : 'pointer'
              }}
            >
              <input
                type="radio"
                name="notify-mode"
                checked={notify?.mine === o.mode}
                disabled={savingMode || !notify}
                onChange={() => void saveMode(o.mode)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#1a1a2e' }}>
                  {o.label}
                </span>
                <span style={{ display: 'block', fontSize: 13, color: '#6b7280', marginTop: 2 }}>
                  {o.detail}
                </span>
              </span>
            </label>
          ))}
        </div>
        {modeMsg && (
          <p style={{ fontSize: 13, color: '#374151', marginTop: 10 }}>{modeMsg}</p>
        )}

        <h3 style={{ ...h3Style, marginTop: 28 }}>Who else receives them</h3>
        {notify?.adminsError ? (
          <p style={{ fontSize: 13, color: '#92400e', margin: '0 0 12px' }}>
            The admin list could not be read, so this cannot be shown right now.
          </p>
        ) : (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            {(notify?.admins ?? []).map(a => (
              <div
                key={a.email}
                style={{
                  display: 'flex', justifyContent: 'space-between', gap: 12,
                  padding: '10px 14px', fontSize: 13, borderTop: '1px solid #f3f4f6'
                }}
              >
                <span style={{ color: '#374151', wordBreak: 'break-all' }}>{a.email}</span>
                <span style={{ color: a.mode === 'off' ? '#9ca3af' : '#1a1a2e', fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {MODE_LABEL[a.mode] ?? a.mode}
                </span>
              </div>
            ))}
            {(notify?.admins ?? []).length === 0 && (
              <div style={{ padding: '10px 14px', fontSize: 13, color: '#6b7280' }}>
                No admins found.
              </div>
            )}
          </div>
        )}
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '8px 0 0', lineHeight: 1.6 }}>
          Each person&apos;s frequency is theirs to change, so these are shown for reference
          only. Admins are added and removed on the{' '}
          <Link href="/admin/team" style={linkStyle}>Team page</Link>.
        </p>

        <p style={{ fontSize: 12, color: '#9ca3af', margin: '18px 0 0', lineHeight: 1.6 }}>
          Right now a new question emails{' '}
          {eachAdmins.length === 0
            ? 'nobody. Questions only appear on the Questions page.'
            : `${eachAdmins.length} ${eachAdmins.length === 1 ? 'person' : 'people'}.`}
        </p>
      </section>

      {/* ---------------- Reminders to BAMs ---------------- */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Reminders to BAMs</h2>
        <p style={pStyle}>
          Sent on the {(reminders?.days ?? [10, 14]).join(' and the ')} of the month to any BAM
          who has not submitted a single receipt yet that month. Anyone who has uploaded
          something, however small, is left alone. BAMs can also turn these off for themselves
          on their own account page.
        </p>

        {reminders?.degraded && (
          <p style={{ fontSize: 13, color: '#92400e', margin: '0 0 12px' }}>
            The current setting could not be read, so this is showing off. Nothing is being sent.
          </p>
        )}

        <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
          {([
            ['off', 'Off', 'Nothing is sent. This is where it is now.'],
            ['draft', 'Record only, do not send', 'The system works out who would get one and records it, but no email leaves. Good for one cycle before turning it on.'],
            ['live', 'Send them', 'BAMs are emailed on the days above.']
          ] as const).map(([mode, label, detail]) => (
            <label
              key={mode}
              style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                border: `1px solid ${reminders?.mode === mode ? '#0073cf' : '#e5e7eb'}`,
                background: reminders?.mode === mode ? '#f0f7ff' : '#fff',
                borderRadius: 8, padding: '12px 14px', cursor: savingReminders ? 'wait' : 'pointer'
              }}
            >
              <input
                type="radio"
                name="reminder-mode"
                checked={reminders?.mode === mode}
                disabled={savingReminders || !reminders}
                onChange={() => void saveReminders(mode)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#1a1a2e' }}>{label}</span>
                <span style={{ display: 'block', fontSize: 13, color: '#6b7280', marginTop: 2 }}>{detail}</span>
              </span>
            </label>
          ))}
        </div>

        {reminderMsg && (
          <p style={{ fontSize: 13, color: reminderMsg.ok ? '#166534' : '#991b1b', margin: '0 0 12px' }}>
            {reminderMsg.text}
          </p>
        )}

        {/* Read it before turning it on. This is the same function the cron uses, so what is
            shown here is what sends. */}
        <button
          onClick={() => setShowPreview(v => !v)}
          style={{
            background: '#fff', border: '1px solid #d1d5db', borderRadius: 8,
            padding: '9px 16px', fontSize: 14, fontWeight: 600, color: '#1a1a2e', cursor: 'pointer'
          }}
        >
          {showPreview ? 'Hide the email' : 'Read the email a BAM would get'}
        </button>

        {showPreview && reminders?.preview && (
          <div style={{ marginTop: 14 }}>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 6px' }}>
              Subject: <strong style={{ color: '#1a1a2e' }}>{reminders.preview.subject}</strong>
            </p>
            <div
              style={{
                border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
                maxHeight: 420, overflow: 'auto'
              }}
              // The real HTML, not a description of it. It comes from our own pure function
              // with no student data in it, so there is nothing here to escape.
              dangerouslySetInnerHTML={{ __html: reminders.preview.html }}
            />
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '8px 0 0', lineHeight: 1.6 }}>
              Example figures. The real email uses each BAM&apos;s own numbers. To change the
              wording, tell Mirae what it should say.
            </p>
          </div>
        )}
      </section>

      {/* ---------------- Invoice email ---------------- */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Invoice email</h2>
        <p style={pStyle}>
          Where approved invoices are sent, one PDF per email, as AP requires.
        </p>

        {invoice ? (
          <>
            {!editingAp ? (
              <>
                <dl style={{ margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.9 }}>
                  <Row label="To" value={invoice.to ?? 'not set'} />
                  <Row label="CC" value={invoice.cc.join(', ') || 'nobody'} />
                  {invoice.from && <Row label="From" value={invoice.from} />}
                  {invoice.replyTo && <Row label="Replies to" value={invoice.replyTo} />}
                </dl>

                {invoice.problems.length > 0 && (
                  <div style={{
                    background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
                    padding: 12, fontSize: 13, color: '#991b1b', marginTop: 12, lineHeight: 1.6
                  }}>
                    <strong>These addresses will not send:</strong>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {invoice.problems.map(p => <li key={p}>{p}</li>)}
                    </ul>
                  </div>
                )}

                {/* The warning stays. It is the reason to be careful, not a reason to be
                    unable to act, and "ask Mirae" was the part that stops working. */}
                <p style={{
                  fontSize: 12, color: '#92400e', background: '#fffbeb',
                  border: '1px solid #fde68a', borderRadius: 8, padding: 12,
                  margin: '12px 0 0', lineHeight: 1.6
                }}>
                  These are the addresses real invoices are sent to. A typo here sends
                  someone&apos;s pay to the wrong inbox, and the send still reports success, so
                  check the spelling before you save.
                </p>

                <button
                  onClick={() => {
                    setApTo(invoice.to ?? '')
                    setApCc(invoice.cc.join(', '))
                    setApMsg(null)
                    setEditingAp(true)
                  }}
                  style={{
                    marginTop: 12, background: '#fff', border: '1px solid #d1d5db',
                    borderRadius: 8, padding: '9px 16px', fontSize: 14, fontWeight: 600,
                    color: '#1a1a2e', cursor: 'pointer'
                  }}
                >
                  Change these addresses
                </button>
                {invoice.source === 'env' && (
                  <p style={{ fontSize: 12, color: '#9ca3af', margin: '8px 0 0' }}>
                    Currently the deployed default. Saving here replaces it, and takes effect on
                    the next send with no redeploy.
                  </p>
                )}
              </>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#1a1a2e' }}>
                  To
                  <input
                    value={apTo}
                    onChange={e => setApTo(e.target.value)}
                    placeholder="accounts.payable@ilovesalt.com"
                    style={apInputStyle}
                  />
                </label>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#1a1a2e' }}>
                  CC
                  <input
                    value={apCc}
                    onChange={e => setApCc(e.target.value)}
                    placeholder="robin.graham@ilovesalt.com, nb@ilovesalt.com"
                    style={apInputStyle}
                  />
                  <span style={{ display: 'block', fontSize: 12, fontWeight: 400, color: '#6b7280', marginTop: 4 }}>
                    Separate several with commas. Leave empty to copy nobody. The BAM is copied
                    on their own invoice automatically and does not go here.
                  </span>
                </label>

                {apMsg && (
                  <div style={{
                    background: apMsg.ok ? '#ecfdf5' : '#fef2f2',
                    border: `1px solid ${apMsg.ok ? '#a7f3d0' : '#fecaca'}`,
                    borderRadius: 8, padding: 12, fontSize: 13,
                    color: apMsg.ok ? '#065f46' : '#991b1b', lineHeight: 1.6
                  }}>
                    {apMsg.text}
                    {apMsg.problems && apMsg.problems.length > 0 && (
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {apMsg.problems.map(p => <li key={p}>{p}</li>)}
                      </ul>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => void saveApAddresses()}
                    disabled={savingAp}
                    style={{
                      background: '#0073cf', border: '1px solid #0073cf', borderRadius: 8,
                      padding: '9px 16px', fontSize: 14, fontWeight: 600, color: '#fff',
                      cursor: savingAp ? 'wait' : 'pointer'
                    }}
                  >
                    {savingAp ? 'Saving...' : 'Save addresses'}
                  </button>
                  <button
                    onClick={() => { setEditingAp(false); setApMsg(null) }}
                    disabled={savingAp}
                    style={{
                      background: '#fff', border: '1px solid #d1d5db', borderRadius: 8,
                      padding: '9px 16px', fontSize: 14, fontWeight: 600, color: '#1a1a2e',
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Loading...</p>
        )}
      </section>

      {/* ---------------- Portal ---------------- */}
      <section style={{ ...sectionStyle, marginBottom: 0 }}>
        <h2 style={h2Style}>Portal</h2>
        <p style={pStyle}>
          Put a notice at the top of the BAM portal, or close it while something is being
          fixed. Takes effect within a minute, including on tabs that are already open.
        </p>
        <Link
          href="/admin/maintenance"
          style={{
            display: 'inline-block', background: '#fff', border: '1px solid #d1d5db',
            borderRadius: 8, padding: '9px 16px', fontSize: 14, fontWeight: 600,
            color: '#1a1a2e', textDecoration: 'none'
          }}
        >
          Notice and maintenance mode
        </Link>
      </section>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <dt style={{ minWidth: 84, fontWeight: 600, color: '#6b7280' }}>{label}</dt>
      <dd style={{ margin: 0, wordBreak: 'break-all' }}>{value}</dd>
    </div>
  )
}

const sectionStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  background: '#fff',
  padding: 24,
  marginBottom: 20
}

const h2Style: React.CSSProperties = {
  fontSize: 17, fontWeight: 700, color: '#1a1a2e', margin: '0 0 4px'
}

const h3Style: React.CSSProperties = {
  fontSize: 14, fontWeight: 700, color: '#1a1a2e', margin: '20px 0 4px'
}

const pStyle: React.CSSProperties = {
  fontSize: 13, color: '#6b7280', margin: '0 0 16px', lineHeight: 1.6
}

const linkStyle: React.CSSProperties = {
  color: '#0073cf', textDecoration: 'none', fontWeight: 500
}

/**
 * The AP address inputs.
 *
 * `width: 100%` with `boxSizing: border-box`: without the second one the padding is added to
 * the 100% and the field overflows the card it sits in, which is the layout mistake this
 * codebase made three times in one session.
 */
const apInputStyle: React.CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6,
  border: '1px solid #d1d5db', borderRadius: 8, padding: '9px 12px',
  fontSize: 14, fontWeight: 400, color: '#1a1a2e', background: '#fff'
}
