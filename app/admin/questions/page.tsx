'use client'

/**
 * Support questions from the portal.
 *
 * WHY THIS PAGE EXISTS
 * /api/portal/support has always saved every question to `portal_questions` and
 * created an admin notification pointing at /admin/questions. That route did not
 * exist, so the notification led to a 404, and nothing anywhere read the table. Email
 * to the program manager was the only path a question actually took -- and the support
 * route's own comment says that if the email fails, "Robin will see it in the
 * dashboard rather than her inbox", which was not true. This is that dashboard.
 *
 * Read-only on purpose. Replying happens over email (the portal collects the BAM's
 * address and the notification email says to reply directly), and a half-built reply
 * box would be a worse promise than none.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AttachmentView } from '@/app/_components/SupportAttachment'
import Link from 'next/link'
import { TopBar } from '../_components/TopBar'
import {
  type QuestionNotifyMode
} from '@/lib/question-notify'

type DbQuestion = {
  id: string
  question: string
  submitted_at: string
  bam_id: string | null
  notified_at: string | null
  answered_at: string | null
  answer: string | null
  /**
   * Set when the thread was opened from an invoice the BAM says is wrong (0035). The card
   * links straight to it: this thread is holding that payment, and reading it without the
   * invoice open means checking the number somewhere else first.
   */
  invoice_id?: string | null
  /** Every message in the thread. Migration 0027. Order is not guaranteed by the join. */
  portal_question_messages?: Array<{
    id: string; author: 'bam' | 'admin'; body: string; created_at: string
    attachment_key?: string | null; attachment_mime?: string | null; attachment_name?: string | null; attachment_bytes?: number | null
  }>
  bams: {
    first_name: string | null
    last_name: string | null
    email: string | null
    school_id: string | null
    cohorts?: { name: string } | { name: string }[] | null
  } | null
}

/**
 * The thread, oldest first.
 *
 * Falls back to the question and answer columns for a row whose messages could not be read, so a card
 * never renders empty. The join does not order, and a thread showing the reply above the question is
 * not a thread.
 */
function threadOf(r: DbQuestion): Array<{
  id: string; author: 'bam' | 'admin'; body: string; created_at: string
  attachment_key?: string | null; attachment_mime?: string | null; attachment_name?: string | null; attachment_bytes?: number | null
}> {
  const m = r.portal_question_messages
  if (Array.isArray(m) && m.length > 0) {
    return [...m].sort((a, b) => a.created_at.localeCompare(b.created_at))
  }
  return [
    { id: 'q', author: 'bam', body: r.question, created_at: r.submitted_at },
    ...(r.answer ? [{ id: 'a', author: 'admin' as const, body: r.answer, created_at: r.answered_at ?? r.submitted_at }] : [])
  ]
}

/** cohorts comes back as an object or a one-element array depending on the join. */
function cohortName(r: DbQuestion): string | null {
  const c = r.bams?.cohorts
  const one = Array.isArray(c) ? c[0] : c
  return one?.name ?? null
}

export default function QuestionsPage() {
  const router = useRouter()
  const [rows, setRows] = useState<DbQuestion[]>([])
  // Robin's own setting, changed from here. See lib/question-notify.ts: the volume of
  // these is unpredictable, so the person receiving the mail controls it rather than
  // asking for a code change.
  const [notify, setNotify] = useState<{ mode: QuestionNotifyMode } | null>(null)
  const [notifyDegraded, setNotifyDegraded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Filter by cohort, because that is the grouping Robin actually thinks in: a question from
  // a summer BAM and one from a fall BAM are different conversations.
  const [cohort, setCohort] = useState('all')
  // Open first, because an open question is the only kind that needs anything from you.
  const [status, setStatus] = useState<'open' | 'answered' | 'all'>('open')
  /** Which card has its reply box open. */
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null)
  /**
   * A question id from ?q=, set by the notification link.
   *
   * Read from window.location in an effect rather than with useSearchParams, which forces this page
   * into a Suspense boundary at build time for a value only used after mount.
   */
  const [focusId, setFocusId] = useState<string | null>(null)

  /** Re-read the list. Called after answering so the card shows what the server stored. */
  async function reload() {
    try {
      const res = await fetch('/api/admin/data?table=questions')
      const j = await res.json()
      // A failed read must not render as "no questions". Unknown is not none --
      // that confusion is what made the empty admin-team list misleading too.
      if (j.error || !res.ok) setError(j.error || `Request failed (${res.status})`)
      else { setRows((j.data ?? []) as DbQuestion[]); setError(null) }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  /**
   * Send a reply, or just mark it done.
   *
   * Empty text means "I already answered this in my own email client", which is faster for a
   * one-line answer and is why the text is optional. The server does the same thing: text sends
   * an email, no text only records it.
   */
  async function answer(id: string, text: string) {
    setBusyId(id)
    setActionMsg(null)
    try {
      const res = await fetch('/api/admin/questions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, answered: true, ...(text.trim() ? { answer: text.trim() } : {}) })
      })
      const j = await res.json()
      if (!res.ok || !j?.ok) {
        setActionMsg({ ok: false, text: j?.message ?? 'That did not work.' })
        return
      }
      setReplyTo(null)
      setReplyText('')
      setActionMsg({
        ok: true,
        text: j.emailed ? 'Sent, and marked answered.' : 'Marked answered. No email was sent.'
      })
      await reload()
    } catch (e) {
      setActionMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusyId(null)
    }
  }

  async function reopen(id: string) {
    setBusyId(id)
    setActionMsg(null)
    try {
      const res = await fetch('/api/admin/questions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, answered: false })
      })
      const j = await res.json()
      if (!res.ok || !j?.ok) setActionMsg({ ok: false, text: j?.message ?? 'That did not work.' })
      else { setActionMsg({ ok: true, text: 'Back in the open list.' }); await reload() }
    } catch (e) {
      setActionMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusyId(null)
    }
  }

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('q')
    if (id) {
      setFocusId(id)
      // All, not Open: a notification about a question somebody already answered would otherwise
      // arrive at a list that has filtered it out, which reads as the link being broken.
      setStatus('all')
    }
  }, [])

  // Scroll to it once the rows are in. Waits for the row to exist rather than firing on mount, or it
  // scrolls to nothing while the list is still loading.
  useEffect(() => {
    if (!focusId || loading) return
    const el = document.getElementById(`q-${focusId}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusId, loading, rows.length])

  useEffect(() => {
    let cancelled = false
    ;(async () => { if (!cancelled) await reload() })()
    ;(async () => {
      try {
        const res = await fetch('/api/admin/question-notify')
        const j = await res.json()
        if (cancelled) return
        setNotify(j?.setting ?? null)
        setNotifyDegraded(Boolean(j?.degraded))
      } catch {
        if (!cancelled) setNotifyDegraded(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Matches the question text, the BAM's name and their email, which is everything shown
  // on a card. Searching for what you can see is the only rule worth having here.
  const q = query.trim().toLowerCase()
  const cohorts = [...new Set(rows.map(cohortName).filter((c): c is string => Boolean(c)))].sort()
  const openCount = rows.filter(r => !r.answered_at).length
  const visible = rows.filter(r => {
    if (status === 'open' && r.answered_at) return false
    if (status === 'answered' && !r.answered_at) return false
    if (cohort !== 'all' && cohortName(r) !== cohort) return false
    if (q === '') return true
    const b = r.bams
    const name = [b?.first_name, b?.last_name].filter(Boolean).join(' ')
    // Everything a card shows is searchable, including school and cohort. Searching for what
    // you can see is the only rule worth having.
    return [r.question, name, b?.email ?? '', b?.school_id ?? '', cohortName(r) ?? '']
      .some(v => String(v).toLowerCase().includes(q))
  })

  const who = (r: DbQuestion) => {
    const b = r.bams
    if (!b) return { name: 'Not linked to a roster row', email: null as string | null }
    const name = [b.first_name, b.last_name].filter(Boolean).join(' ')
    return { name: name || 'Unnamed', email: b.email }
  }

  return (
    <>
      <TopBar crumbs={['Support', 'Questions']} />
      <div className="surface">
        <div style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: 'var(--bl-navy)', marginBottom: 4 }}>
            Support questions
          </h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Everything BAMs have sent from the portal Support page. Replying here emails them and
            records it.
          </p>
        </div>

        {/* The frequency control used to be a block of radio buttons here. It moved to
            /admin/settings, where it sits next to the recipient list and the maintenance
            switch, because "who gets emailed about what" was spread across three pages and
            an environment variable. What stays here is the CURRENT answer, so this page
            still tells you whether you are being emailed without making you go look. */}
        <div style={{
          marginBottom: 20, padding: '12px 14px', borderRadius: 10,
          border: '1px solid rgba(0,0,0,0.08)', background: 'rgba(0,163,224,0.04)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          gap: 12, flexWrap: 'wrap'
        }}>
          <div style={{ fontSize: 13, color: 'var(--bl-navy)' }}>
            {notifyDegraded
              ? 'Your email setting could not be read just now.'
              : notify?.mode === 'each'
                ? 'You are emailed about every question as it arrives.'
                : notify?.mode === 'daily'
                  ? 'You get one summary a day listing new questions.'
                  : notify?.mode === 'off'
                    ? 'You are not emailed about these. This page is the only place they appear.'
                    : 'Checking how often you are emailed...'}
          </div>
          <Link href="/admin/settings" style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
            Change in Settings
          </Link>
        </div>

        {/* Always rendered when there is anything to search. This was gated on
            rows.length > 3, which meant that with one question on the page the search box did
            not exist, and the reasonable conclusion was that it had never been built. */}
        {!loading && !error && rows.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {/* Open first. An answered question is history; an open one is work.
                gap 6, not 0: these are three separate bordered buttons, so butting them together
                read as crammed rather than as one segmented control. */}
            <div style={{ display: 'flex', gap: 6 }}>
              {([
                ['open', openCount > 0 ? `Open (${openCount})` : 'Open'],
                ['answered', 'Answered'],
                ['all', 'All']
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setStatus(key)}
                  className={status === key ? 'btn-navy' : 'btn-ghost'}
                  style={{ fontSize: 13, whiteSpace: 'nowrap' }}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search questions, names, emails or schools"
              style={{
                flex: '1 1 220px', minWidth: 0, boxSizing: 'border-box',
                padding: '10px 12px', fontSize: 13, fontFamily: 'inherit',
                border: '1px solid rgba(0,0,0,0.15)', borderRadius: 8
              }}
            />
            {cohorts.length > 1 && (
              <select
                value={cohort}
                onChange={e => setCohort(e.target.value)}
                style={{
                  padding: '10px 12px', fontSize: 13, fontFamily: 'inherit',
                  border: '1px solid rgba(0,0,0,0.15)', borderRadius: 8, background: '#fff'
                }}
              >
                <option value="all">All cohorts</option>
                {cohorts.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            {(query.trim() !== '' || cohort !== 'all' || status !== 'open') && (
              <button
                onClick={() => { setQuery(''); setCohort('all'); setStatus('open') }}
                className="btn-ghost"
                style={{ fontSize: 13 }}
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* The count, so a filter that hides most of the page says so. */}
        {!loading && !error && rows.length > 0 && (
          <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
            Showing {visible.length} of {rows.length}
          </p>
        )}

        {focusId && visible.some(r => r.id === focusId) && (
          <p style={{ fontSize: 12, color: 'var(--bl-blue)', marginTop: -8, marginBottom: 12 }}>
            Showing the question from your notification.{' '}
            <button
              onClick={() => setFocusId(null)}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontSize: 12, color: 'var(--midgray)', textDecoration: 'underline'
              }}
            >
              Clear
            </button>
          </p>
        )}

        {focusId && !loading && !visible.some(r => r.id === focusId) && (
          <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
            The question from that notification is no longer here. It may have been deleted.
          </p>
        )}

        {actionMsg && (
          <p style={{
            fontSize: 13, marginBottom: 12,
            color: actionMsg.ok ? '#065f46' : '#991b1b'
          }}>
            {actionMsg.text}
          </p>
        )}

        {loading && <p className="muted">Loading…</p>}

        {error && (
          <div style={{
            padding: '12px 14px', borderRadius: 8, fontSize: 13,
            background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)',
            color: '#991b1b'
          }}>
            We could not load the questions: {error}. This does not mean there are none.
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <p className="muted" style={{ fontSize: 13 }}>
            No questions have been submitted yet.
          </p>
        )}

        {!loading && !error && rows.length > 0 && visible.length === 0 && (
          <p className="muted" style={{ fontSize: 13 }}>
            {status === 'open' && query.trim() === '' && cohort === 'all'
              ? 'Nothing waiting. Every question has been answered.'
              : `Nothing matches. ${rows.length} question${rows.length === 1 ? '' : 's'} in total.`}
          </p>
        )}

        {!loading && !error && visible.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {visible.map(r => {
              const w = who(r)
              return (
                <div key={r.id} id={`q-${r.id}`} style={{
                  padding: '14px 16px', borderRadius: 10,
                  // The one the notification pointed at. Outline rather than a different background,
                  // so it does not fight the Waiting / Answered colouring that means something.
                  ...(focusId === r.id
                    ? { boxShadow: '0 0 0 2px var(--bl-blue, #0073cf)', scrollMarginTop: 80 }
                    : {}),
                  // An answered card recedes. Left unstyled they were all identical, which is
                  // why there was no way to tell what still needed attention.
                  border: r.answered_at ? '1px solid rgba(0,0,0,0.06)' : '1px solid rgba(0,163,224,0.35)',
                  background: r.answered_at ? 'rgba(0,0,0,0.015)' : 'rgba(0,163,224,0.04)',
                  opacity: r.answered_at ? 0.85 : 1
                }}>
                  {/* Status word first, same vocabulary the student sees on their own thread, so the
                      two screens describe the same state in the same words. Name and address are
                      metadata: quieter than the question, which is the thing being read. */}
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    gap: 12, marginBottom: 10, flexWrap: 'wrap'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span style={{
                        display: 'inline-block', padding: '2px 9px', borderRadius: 999,
                        fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
                        background: r.answered_at ? 'rgba(34,197,94,0.12)' : 'rgba(0,163,224,0.14)',
                        color: r.answered_at ? '#166534' : '#0369a1'
                      }}>
                        {r.answered_at ? 'Answered' : 'Waiting'}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--bl-navy)' }}>
                        {w.name}
                      </span>
                      {cohortName(r) && (
                        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                          {cohortName(r)}
                        </span>
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {new Date(r.submitted_at).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
                      })}
                    </div>
                  </div>
                  {/* THE THREAD, not one question with one reply under it. A follow-up used to arrive
                      as a separate unrelated card and a second reply overwrote the first. */}
                  {threadOf(r).map(m => (
                    <div
                      key={m.id}
                      style={{
                        marginTop: 10,
                        ...(m.author === 'admin'
                          ? {
                              padding: '10px 12px', borderRadius: 8,
                              background: 'rgba(0,0,0,0.03)', borderLeft: '3px solid rgba(0,163,224,0.5)'
                            }
                          : {})
                      }}
                    >
                      <div className="muted" style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                        {m.author === 'admin' ? 'Replied' : who(r).name}
                        <span style={{ fontWeight: 400 }}>
                          {' · '}{new Date(m.created_at).toLocaleString('en-US', {
                            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
                          })}
                        </span>
                      </div>
                      <div style={{
                        fontSize: m.author === 'admin' ? 13 : 15,
                        color: m.author === 'admin' ? '#374151' : '#1a1a2e',
                        whiteSpace: 'pre-wrap', lineHeight: 1.65
                      }}>
                        {m.body}
                      </div>
                      {m.attachment_key && (
                        <AttachmentView
                          attachmentKey={m.attachment_key}
                          mime={m.attachment_mime ?? null}
                          name={m.attachment_name}
                          bytes={m.attachment_bytes}
                        />
                      )}
                    </div>
                  ))}

                  {replyTo === r.id ? (
                    <div style={{ marginTop: 12 }}>
                      <textarea
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        rows={4}
                        autoFocus
                        placeholder={`Reply to ${w.name.split(' ')[0]}. This is emailed to them and saved here.`}
                        style={{
                          width: '100%', boxSizing: 'border-box', fontSize: 13, fontFamily: 'inherit',
                          padding: '10px 12px', border: '1px solid rgba(0,0,0,0.15)',
                          borderRadius: 8, resize: 'vertical'
                        }}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                          className="btn-navy"
                          disabled={busyId === r.id || replyText.trim().length === 0}
                          onClick={() => void answer(r.id, replyText)}
                          style={{ fontSize: 13 }}
                        >
                          {busyId === r.id ? 'Sending...' : 'Send and mark answered'}
                        </button>
                        <button
                          className="btn-ghost"
                          disabled={busyId === r.id}
                          onClick={() => { setReplyTo(null); setReplyText('') }}
                          style={{ fontSize: 13 }}
                        >
                          Cancel
                        </button>
                        {!w.email && (
                          <span style={{ fontSize: 12, color: '#991b1b' }}>
                            No email on file for this BAM, so a reply cannot be sent.
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                      {!r.answered_at && (
                        <>
                          {/* ONE primary action. Reply is what this page is for. */}
                          <button
                            className="btn-navy"
                            disabled={busyId === r.id}
                            onClick={() => { setReplyTo(r.id); setReplyText('') }}
                            style={{ fontSize: 13 }}
                          >
                            Reply
                          </button>
                          {/*
                            Secondary, and deliberately quieter: a bordered button the same size and
                            weight as Reply made the two look like equal choices, and the longer label
                            made the escape hatch the widest thing on the card.
                            Shortened to "Mark answered" with the explanation as a tooltip. It exists
                            for when the reply already went out of Outlook; without it the only way to
                            close a question is to retype the answer.
                          */}
                          <button
                            disabled={busyId === r.id}
                            onClick={() => void answer(r.id, '')}
                            title="Use this if you already replied from your own email. Records it as answered without sending anything."
                            style={{
                              fontSize: 13, background: 'none', border: 'none', padding: '6px 4px',
                              color: 'var(--midgray)', cursor: 'pointer', textDecoration: 'underline',
                              textUnderlineOffset: 3
                            }}
                          >
                            {busyId === r.id ? 'Saving...' : 'Mark answered'}
                          </button>
                        </>
                      )}
                      {r.answered_at && (
                        <>
                          <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
                            Answered {new Date(r.answered_at).toLocaleDateString('en-US', {
                              month: 'short', day: 'numeric'
                            })}
                          </span>
                          <button
                            className="btn-ghost"
                            disabled={busyId === r.id}
                            onClick={() => void reopen(r.id)}
                            style={{ fontSize: 13 }}
                          >
                            Reopen
                          </button>
                        </>
                      )}
                      {/*
                        Was an <a className="btn-ghost">, which rendered as underlined text inside a
                        stray outline: .btn-ghost is written for <button> and the global anchor
                        underline won. It is a tertiary action, so it is now plainly a link and sits
                        on the right, away from the two that change state.
                      */}
                      {/*
                        An invoice thread is holding that invoice's payment, so the invoice is
                        the first thing you need in front of you to answer it.
                        A <button>, not an <a className="btn-ghost">: see the note above, which
                        this repeated once before it was noticed. Navigation goes through the
                        router so the page does not do a full reload to move one screen.
                      */}
                      {r.invoice_id && (
                        <button
                          className="btn-ghost"
                          style={{ fontSize: 13 }}
                          onClick={() => router.push(`/admin/invoices?invoice=${r.invoice_id}`)}
                        >
                          Open the invoice
                        </button>
                      )}
                      {w.email && (
                        <a
                          href={`mailto:${w.email}?subject=${encodeURIComponent('Re: your Bud Light U question')}`}
                          style={{
                            fontSize: 12, color: 'var(--midgray)', alignSelf: 'center',
                            marginLeft: 'auto', whiteSpace: 'nowrap'
                          }}
                          title={w.email}
                        >
                          Open in my email
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
