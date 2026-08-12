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
  bams: {
    first_name: string | null
    last_name: string | null
    email: string | null
    school_id: string | null
    cohorts?: { name: string } | { name: string }[] | null
  } | null
}

/** cohorts comes back as an object or a one-element array depending on the join. */
function cohortName(r: DbQuestion): string | null {
  const c = r.bams?.cohorts
  const one = Array.isArray(c) ? c[0] : c
  return one?.name ?? null
}

export default function QuestionsPage() {
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

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/admin/data?table=questions')
        const j = await res.json()
        if (cancelled) return
        // A failed read must not render as "no questions". Unknown is not none --
        // that confusion is what made the empty admin-team list misleading too.
        if (j.error || !res.ok) setError(j.error || `Request failed (${res.status})`)
        else setRows((j.data ?? []) as DbQuestion[])
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
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
  const visible = rows.filter(r => {
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
            Everything BAMs have sent from the portal Support page. Reply by email to the
            address shown.
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
            {(query.trim() !== '' || cohort !== 'all') && (
              <button
                onClick={() => { setQuery(''); setCohort('all') }}
                className="btn-ghost"
                style={{ fontSize: 13 }}
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* The count, so a filter that hides most of the page says so. */}
        {!loading && !error && rows.length > 0 && (query.trim() !== '' || cohort !== 'all') && (
          <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
            Showing {visible.length} of {rows.length}
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
            Nothing matches. {rows.length} question{rows.length === 1 ? '' : 's'} in total.
          </p>
        )}

        {!loading && !error && visible.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {visible.map(r => {
              const w = who(r)
              return (
                <div key={r.id} style={{
                  padding: '14px 16px', borderRadius: 10,
                  border: '1px solid rgba(0,0,0,0.08)', background: 'rgba(0,0,0,0.015)'
                }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                    gap: 12, marginBottom: 8, flexWrap: 'wrap'
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--bl-navy)' }}>
                      {w.name}
                      {w.email && (
                        <a href={`mailto:${w.email}`} style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                          {w.email}
                        </a>
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {new Date(r.submitted_at).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
                      })}
                    </div>
                  </div>
                  <div style={{ fontSize: 14, color: '#1a1a2e', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                    {r.question}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
