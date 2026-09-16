'use client'
import { Fragment, useEffect, useState } from 'react'
import { browserClient } from '@/lib/supabase-browser'

type InvoiceRow = {
  id: string
  period: string
  status: string
  invoice_number: string | null
  seq: number | null
  created_at: string
  /**
   * When this invoice was published for the BAM to check, which starts their 24 hours
   * (0035). Null means it is still being prepared and there is nothing to object to yet.
   */
  released_at: string | null
  /**
   * When the amount last changed after release (0036). The row stays on screen and says
   * it was corrected rather than disappearing, and the 24 hours restart from here.
   */
  revised_at: string | null
  /**
   * The question thread about THIS invoice, answered or not, with its messages.
   *
   * It is rendered on the row rather than behind a link to Support, because it is about
   * this invoice and nothing else: Mirae, 2026-09-16, "이거 question 이 support 로 가는데,
   * 그럼 구분이 힘들어져서 해당 인보이스에서 할수 없나". The thread is still an ordinary
   * portal_questions row, so the admin side, the emails and the reopen-on-reply behaviour
   * are all the ones that already exist.
   */
  thread?: InvoiceThread | null
}

type ThreadMessage = { id: string; author: string; body: string; created_at: string }

type InvoiceThread = {
  id: string
  question: string
  submitted_at: string
  answered_at: string | null
  answer: string | null
  messages: ThreadMessage[]
}

/** The later of release and revision: what the BAM's current 24 hours run from. */
function windowStart(inv: InvoiceRow): Date | null {
  if (!inv.released_at) return null
  const released = new Date(inv.released_at)
  if (!inv.revised_at) return released
  const revised = new Date(inv.revised_at)
  return revised > released ? revised : released
}

/** An invoice thread nobody has answered yet. That is what holds the payment. */
function isOpen(t: InvoiceThread | null | undefined): boolean {
  return Boolean(t && !t.answered_at)
}

/** True when the figure moved after they were first asked to check it. */
function wasRevised(inv: InvoiceRow): boolean {
  return Boolean(inv.released_at && inv.revised_at && new Date(inv.revised_at) > new Date(inv.released_at))
}

const DUMMY_INVOICES: InvoiceRow[] = [
  { id: 'demo-1', period: '2026-09-01', status: 'sent', invoice_number: 'INV-AT1', seq: 1, created_at: '2026-09-16T18:00:00Z', released_at: '2026-09-16T13:00:00Z', revised_at: null },
  { id: 'demo-2', period: '2026-10-01', status: 'draft', invoice_number: 'INV-AT2', seq: 2, created_at: '2026-10-16T18:00:00Z', released_at: null, revised_at: null },
]

export default function MyInvoices() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [emailing, setEmailing] = useState<string | null>(null)
  const [emailMsg, setEmailMsg] = useState<string | null>(null)
  /** Which invoice the "something looks wrong" form is open on, if any. */
  const [disputeFor, setDisputeFor] = useState<string | null>(null)
  const [disputeText, setDisputeText] = useState('')
  const [disputeBusy, setDisputeBusy] = useState(false)
  const [disputeMsg, setDisputeMsg] = useState<string | null>(null)
  /** Which thread the inline reply box is open on. */
  const [replyFor, setReplyFor] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replyBusy, setReplyBusy] = useState(false)

  /*
   * A follow-up on the invoice's own thread. Same endpoint the Support page posts to, so
   * it reopens the thread, puts it back in the admin queue, emails them, and (because the
   * thread points at this invoice) holds the payment again.
   */
  async function sendReply(inv: InvoiceRow, t: InvoiceThread) {
    setReplyBusy(true)
    try {
      const res = await fetch('/api/portal/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: t.id, body: replyText })
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) {
        setDisputeMsg(j.message || `Could not send that (${res.status})`)
        return
      }
      const added: ThreadMessage = {
        id: j.message?.id ?? `local-${Date.now()}`,
        author: 'bam',
        body: replyText,
        created_at: new Date().toISOString()
      }
      setInvoices(prev => prev.map(r => r.id === inv.id && r.thread
        ? { ...r, thread: { ...r.thread, answered_at: null, messages: [...r.thread.messages, added] } }
        : r))
      setReplyFor(null)
      setReplyText('')
      setDisputeMsg('Sent. Your program manager has it, and nothing goes out until they answer.')
    } finally {
      setReplyBusy(false)
      setTimeout(() => setDisputeMsg(null), 8000)
    }
  }

  async function submitDispute(inv: InvoiceRow) {
    setDisputeBusy(true)
    setDisputeMsg(null)
    try {
      const res = await fetch('/api/portal/invoices/dispute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: inv.id, reason: disputeText })
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) {
        setDisputeMsg(j.message || `Could not send that (${res.status})`)
        return
      }
      // Reflect it immediately. The row has to stop offering the button the moment the
      // message lands, or they send the same thing three times waiting for a reload.
      setInvoices(prev => prev.map(r => r.id === inv.id
        ? { ...r, thread: { id: j.question_id, question: disputeText, submitted_at: new Date().toISOString(), answered_at: null, answer: null, messages: [{ id: `local-${Date.now()}`, author: 'bam', body: disputeText, created_at: new Date().toISOString() }] } }
        : r))
      setDisputeFor(null)
      setDisputeText('')
      setDisputeMsg(j.already_sent
        ? 'Your program manager has this. This invoice had already gone to accounts payable, so it cannot be pulled back, but they will sort it out with you.'
        : 'Your program manager has this. Nothing will be sent until it is sorted out.')
    } catch {
      setDisputeMsg('Could not send that. Please try again.')
    } finally {
      setDisputeBusy(false)
      setTimeout(() => setDisputeMsg(null), 8000)
    }
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const isDev = process.env.NODE_ENV === 'development'
        const sb = browserClient()
        const { data: userRes } = await sb.auth.getUser()

        let bamId: string | null = null
        if (userRes.user) {
          const { data: bam } = await sb.from('bams').select('id').eq('auth_user_id', userRes.user.id).single()
          bamId = bam?.id ?? null
        } else if (isDev) {
          const { data: firstBam } = await sb.from('bams').select('id').limit(1).single()
          bamId = firstBam?.id ?? null
        }

        if (!bamId) {
          if (isDev) setInvoices(DUMMY_INVOICES)
          setLoading(false)
          return
        }

        const { data } = await sb
          .from('invoices')
          .select('id, period, status, invoice_number, seq, created_at, released_at, revised_at')
          .eq('bam_id', bamId)
          .order('period', { ascending: false })

        /*
         * Their own unanswered threads about an invoice (0035).
         *
         * Through the API, not the table. RLS on portal_questions grants a BAM insert and
         * admins select, and nothing lets a student read their own rows: a direct query
         * here would return an empty list forever and the row would keep offering a button
         * they had already used. /portal/support reads through this same route for exactly
         * that reason.
         */
        const threads: Array<InvoiceThread & { invoice_id: string | null; portal_question_messages?: ThreadMessage[] }> =
          await fetch('/api/portal/questions')
            .then(r => r.json())
            .then(j => (j?.questions ?? j?.data ?? []))
            .catch(() => [])

        if (!cancelled) {
          // Answered threads are kept, not filtered out: the reply is the thing the BAM
          // came back to read, and it belongs on the invoice it is about.
          const byInvoice = new Map<string, InvoiceThread>()
          for (const t of threads) {
            if (!t.invoice_id) continue
            byInvoice.set(t.invoice_id, {
              id: t.id,
              question: t.question,
              submitted_at: t.submitted_at,
              answered_at: t.answered_at ?? null,
              answer: t.answer ?? null,
              messages: (t.portal_question_messages ?? []).slice().sort(
                (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
              )
            })
          }
          const rows = (data ?? []).map(r => ({ ...r, thread: byInvoice.get(r.id) ?? null }))
          setInvoices(rows.length > 0 ? rows : isDev ? DUMMY_INVOICES : [])
        }
      } catch {
        if (process.env.NODE_ENV === 'development') setInvoices(DUMMY_INVOICES)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  function periodLabel(period: string) {
    try {
      return new Date(period + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    } catch {
      return period
    }
  }

  /**
   * The three actions, shared between the desktop table row and the mobile card below.
   *
   * Measured at 390px (iPhone 14/15/16, the single most common size among North American
   * students -- roughly 87% of US teens carry an iPhone per Piper Sandler's survey, and this
   * has been Apple's mainstream body size for several generations): the table rendered at
   * 572px wide and all three buttons sat past the right edge of the screen, reachable only by
   * scrolling sideways inside the table. Extracted here so the fix (a stacked mobile card,
   * below) calls the exact same handlers instead of a second copy that can drift from this one.
   */
  function invoiceActions(inv: InvoiceRow, wrap: boolean) {
    /*
     * A released draft gets the buttons. Objecting to an invoice you cannot open is not a
     * review, it is a guess, so the 24-hour window and the PDF have to arrive together
     * (0035). An unreleased draft still shows nothing: there is no final figure yet.
     */
    if (inv.status === 'draft' && !inv.released_at) return null
    return (
      <div style={{ display: 'flex', gap: 4, flexWrap: wrap ? 'wrap' : 'nowrap' }}>
        <a
          href={`/api/portal/invoices/download?id=${inv.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost"
          style={{ padding: '5px 12px', fontSize: 12, textDecoration: 'none', display: 'inline-block' }}
        >
          View PDF
        </a>
        <button
          className="btn-ghost"
          style={{ padding: '5px 12px', fontSize: 12 }}
          disabled={downloading === inv.id}
          onClick={async () => {
            setDownloading(inv.id)
            try {
              const res = await fetch(`/api/portal/invoices/download?id=${inv.id}`)
              if (!res.ok) return
              const blob = await res.blob()
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `${inv.invoice_number ?? 'invoice'}.pdf`
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(url)
            } finally { setDownloading(null) }
          }}
        >
          {downloading === inv.id ? '...' : 'Download'}
        </button>
        <button
          className="btn-ghost"
          style={{ padding: '5px 12px', fontSize: 12 }}
          disabled={emailing === inv.id}
          onClick={() => emailMeCopy(inv)}
        >
          {emailing === inv.id ? '...' : 'Email me'}
        </button>
        {/*
          Offered while the invoice is still ours to hold. Once it is with AP the button
          goes away, because a button that cannot do what it says is worse than none: the
          Support page is the honest route at that point.
        */}
        {inv.status === 'draft' && inv.released_at && !isOpen(inv.thread) && !inv.thread && (
          <button
            className="btn-ghost"
            style={{ padding: '5px 12px', fontSize: 12, color: 'var(--red)' }}
            onClick={() => { setDisputeFor(inv.id); setDisputeText(''); setDisputeMsg(null) }}
          >
            Something looks wrong
          </button>
        )}
        {inv.thread && (
          <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
            {isOpen(inv.thread) ? 'Waiting for a reply' : 'Answered below'}
          </span>
        )}
      </div>
    )
  }

  /*
   * The state of the window, in words, under the row it belongs to.
   *
   * Shown for the whole of the review, from release until the invoice leaves for AP, so a
   * BAM can always see where they are instead of inferring it from a badge. A correction
   * says so here rather than quietly resetting a clock nobody was watching.
   */
  function windowLine(inv: InvoiceRow) {
    if (inv.status !== 'draft' || !inv.released_at) return null
    const start = windowStart(inv)
    if (!start) return null
    const closes = new Date(start.getTime() + 24 * 60 * 60 * 1000)
    const closesLabel = closes.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    })
    if (isOpen(inv.thread)) {
      return (
        <div className="muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
          On hold while your program manager answers you. Nothing goes out until then.
        </div>
      )
    }
    return (
      <div className="muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
        {wasRevised(inv)
          ? `This was corrected on ${new Date(inv.revised_at as string).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, so please look again. `
          : ''}
        If we do not hear from you by {closesLabel}, it goes to accounts payable as it stands.
      </div>
    )
  }

  /*
   * The conversation about this invoice, on this invoice.
   *
   * It used to be a link to /portal/support, where an invoice objection sat among general
   * questions and stopped looking like it was about anything in particular. Same thread,
   * same endpoints, same emails; it is just rendered where it belongs.
   */
  function threadPanel(inv: InvoiceRow) {
    const t = inv.thread
    if (!t) return null
    const open = isOpen(t)
    // The stored `question` is the first message too, so it would print twice.
    const body = t.messages.length > 0
      ? t.messages
      : [{ id: t.id, author: 'bam', body: t.question, created_at: t.submitted_at }]

    return (
      <div style={{ marginTop: 8, padding: 14, background: 'var(--bl-fog)', borderRadius: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
          About this invoice
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            {open ? 'waiting for a reply' : 'answered'}
          </span>
        </div>

        {body.map(m => (
          <div key={m.id} style={{ marginBottom: 8 }}>
            <div className="muted" style={{ fontSize: 11 }}>
              {m.author === 'admin' ? 'Your program manager' : 'You'}
              {' · '}
              {new Date(m.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{m.body}</div>
          </div>
        ))}

        {/* The answer column, for a thread answered before messages existed (0027 backfilled
            once; older rows can still carry an answer with no matching message row). */}
        {!open && t.answer && !body.some(m => m.author === 'admin') && (
          <div style={{ marginBottom: 8 }}>
            <div className="muted" style={{ fontSize: 11 }}>Your program manager</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{t.answer}</div>
          </div>
        )}

        {replyFor === t.id ? (
          <div style={{ marginTop: 8 }}>
            <textarea
              className="input"
              style={{ display: 'block', width: '100%', minHeight: 60 }}
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              placeholder="Add anything else about this invoice"
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="btn-navy" disabled={replyBusy} onClick={() => sendReply(inv, t)}>
                {replyBusy ? 'Sending…' : 'Send'}
              </button>
              <button className="btn-ghost" disabled={replyBusy} onClick={() => setReplyFor(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn-ghost"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => { setReplyFor(t.id); setReplyText('') }}
          >
            Reply
          </button>
        )}
      </div>
    )
  }

  function disputeForm(inv: InvoiceRow) {
    if (disputeFor !== inv.id) return null
    return (
      <div style={{ marginTop: 8, padding: 14, background: 'var(--bl-fog)', borderRadius: 8, maxWidth: 620 }}>
        <label style={{ fontSize: 12, fontWeight: 600, display: 'block' }}>
          What looks wrong?
          <textarea
            className="input"
            style={{ display: 'block', width: '100%', marginTop: 4, minHeight: 70 }}
            value={disputeText}
            onChange={e => setDisputeText(e.target.value)}
            placeholder="e.g. the reimbursement line is $40 short, I sent three receipts in September"
          />
        </label>
        <p className="muted" style={{ fontSize: 11, margin: '6px 0 8px', lineHeight: 1.5 }}>
          This holds the invoice. Nothing goes to accounts payable until your program manager has answered you.
        </p>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-navy" disabled={disputeBusy} onClick={() => submitDispute(inv)}>
            {disputeBusy ? 'Sending…' : 'Send'}
          </button>
          <button className="btn-ghost" disabled={disputeBusy} onClick={() => setDisputeFor(null)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  async function emailMeCopy(inv: InvoiceRow) {
    setEmailing(inv.id)
    setEmailMsg(null)
    try {
      const res = await fetch('/api/portal/invoices/email-copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: inv.id })
      })
      const j = await res.json()
      // A partial success (the mail went out, but the PDF's storage key could not be
      // recorded) arrives as `warning` and used to be dropped, so the student was told
      // it was sent either way.
      setEmailMsg(
        j.ok
          ? (j.warning ? `Sent, but: ${j.warning}` : 'Invoice copy sent to your email')
          : (j.error || j.message || 'Failed to send')
      )
    } catch {
      setEmailMsg('Failed to send')
    } finally {
      setEmailing(null)
      setTimeout(() => setEmailMsg(null), 4000)
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">My invoices</span></div>
      </div>

      <p className="eyebrow">MY PORTAL</p>
      <h1>My invoices</h1>

      {emailMsg && (
        <div className="badge badge-green" style={{ display: 'inline-block', marginTop: 8, marginBottom: 8, padding: '6px 14px', fontSize: 13 }}>
          {emailMsg}
        </div>
      )}

      {disputeMsg && (
        <div
          className="surface"
          style={{ marginTop: 8, marginBottom: 8, padding: '10px 14px', fontSize: 13, maxWidth: 620, lineHeight: 1.6 }}
        >
          {disputeMsg}
        </div>
      )}

      <div className="surface" style={{ marginTop: 16, overflowX: 'auto' }}>
        {loading ? (
          <p className="subtle">Loading...</p>
        ) : invoices.length === 0 ? (
          <div className="empty-state">
            No invoices yet. Receipts close on the 15th and invoices are generated the day after.
          </div>
        ) : (
          <>
          {/*
            A 480px table inside a 375px phone makes the whole PAGE scroll sideways, which is
            the most common way a mobile layout breaks. The wrapper confines that scroll to the
            table. globals.css sets `table.admin-table { min-width: 600px }`, so every one of
            these needs a wrapper; /portal/account already had its own and this was the one
            that did not.

            THAT CONTAINMENT WAS NOT ENOUGH ON ITS OWN. Measured at 390px (iPhone 14/15/16,
            the size most North American students carry): the page itself stayed put, but the
            table rendered at 572px and the three action buttons -- View PDF, Download, Email
            me -- sat entirely past the right edge, reachable only by scrolling sideways inside
            a narrow cell. That is not a page-breaking bug, but it is not a usable download
            button either. `.invoice-cards` below is the fix: a stacked layout for phones,
            CSS-toggled against this table at the same breakpoint globals.css already uses for
            the sidebar, so there is one place that defines "this is a phone" rather than two.
          */}
          <div className="table-scroll invoice-table-wrap">
          <table className="admin-table" style={{ minWidth: 480 }}>
            <thead>
              <tr>
                <th>Period</th>
                <th>Invoice #</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => {
                /*
                 * The conversation and the deadline get their own full-width row under the
                 * invoice, not the actions cell.
                 *
                 * They started inside that cell, which put a paragraph and a whole thread
                 * into the narrowest column on the page: the left half sat empty while the
                 * text wrapped against the right edge. They are about the invoice, not
                 * about the buttons, so they belong under the whole row.
                 */
                const detail = [windowLine(inv), threadPanel(inv), disputeForm(inv)].filter(Boolean)
                return (
                  <Fragment key={inv.id}>
                    <tr>
                      <td style={{ fontWeight: 600, color: 'var(--bl-navy)' }}>{periodLabel(inv.period)}</td>
                      <td style={{ fontFamily: 'monospace', color: 'var(--bl-blue)' }}>{inv.invoice_number ?? '—'}</td>
                      <td><span className={`badge badge-${statusBadge(inv)}`}>{statusText(inv)}</span></td>
                      <td>{invoiceActions(inv, false)}</td>
                    </tr>
                    {detail.length > 0 && (
                      <tr>
                        <td colSpan={4} style={{ paddingTop: 0 }}>{detail}</td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          </div>

          {/* The phone layout. Same data, same handlers (invoiceActions), no second fetch and
              no duplicated download/email logic to drift out of sync with the table above. */}
          <div className="invoice-cards">
            {invoices.map(inv => (
              <div key={inv.id} className="invoice-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontWeight: 600, color: 'var(--bl-navy)', fontSize: 15 }}>{periodLabel(inv.period)}</span>
                  <span className={`badge badge-${statusBadge(inv)}`}>{statusText(inv)}</span>
                </div>
                <div style={{ fontFamily: 'monospace', color: 'var(--bl-blue)', fontSize: 13, marginTop: 4 }}>
                  {inv.invoice_number ?? '—'}
                </div>
                {invoiceActions(inv, true) && (
                  <div style={{ marginTop: 10 }}>{invoiceActions(inv, true)}</div>
                )}
                {windowLine(inv)}
                {threadPanel(inv)}
                {disputeForm(inv)}
              </div>
            ))}
          </div>
          </>
        )}
      </div>
    </>
  )
}

/*
 * A released draft is its own state on screen even though the database still calls it a
 * draft, because it is the only row the BAM has to DO something about. Reading `status`
 * alone would put "Being prepared" on the one invoice that is waiting on them.
 */
function statusBadge(inv: InvoiceRow): string {
  if (isOpen(inv.thread)) return 'yellow'
  if (inv.status === 'draft' && wasRevised(inv)) return 'blue'
  if (inv.status === 'draft' && inv.released_at) return 'yellow'
  switch (inv.status) {
    case 'sent':  return 'blue'
    case 'paid':  return 'green'
    case 'void':  return 'red'
    case 'draft': return 'yellow'
    default:      return 'yellow'
  }
}

function statusText(inv: InvoiceRow): string {
  if (isOpen(inv.thread)) return 'Your question is with us'
  // Said plainly, because the number they looked at yesterday is not the number now.
  if (inv.status === 'draft' && wasRevised(inv)) return 'Updated, please check again'
  if (inv.status === 'draft' && inv.released_at) return 'Please check by tomorrow'
  switch (inv.status) {
    case 'sent':  return 'Sent to AP'
    case 'paid':  return 'Paid'
    case 'void':  return 'Voided'
    case 'draft': return 'Being prepared'
    default:      return inv.status
  }
}
