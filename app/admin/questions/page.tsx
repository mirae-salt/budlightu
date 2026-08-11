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
import { TopBar } from '../_components/TopBar'

type DbQuestion = {
  id: string
  question: string
  submitted_at: string
  bam_id: string | null
  bams: { first_name: string | null; last_name: string | null; email: string | null } | null
}

export default function QuestionsPage() {
  const [rows, setRows] = useState<DbQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
    return () => { cancelled = true }
  }, [])

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

        {!loading && !error && rows.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rows.map(r => {
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
