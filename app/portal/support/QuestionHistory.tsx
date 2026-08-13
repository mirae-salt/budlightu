/**
 * The BAM's own questions and answers, in the portal.
 *
 * The Support page took a question and then showed nothing back: no history, no answer, no evidence
 * it had been received. The reply arrived by email and that was the only copy, so a student who
 * deleted the mail, or who asked twice because they were not sure the first one landed, had nowhere
 * to look.
 *
 * Renders nothing until it knows. An empty list here is a statement, and "we never got your
 * question" is the one wrong thing this component can say by accident, so a failed read says so
 * instead of showing zero.
 *
 * One question and one answer per card, because that is what `portal_questions` stores. A real
 * back-and-forth needs a child table; see HANDOFF-2026-08-13.md section 1.3.
 */
'use client'

import { useEffect, useState } from 'react'

type Row = {
  id: string
  question: string
  answer: string | null
  answered_at: string | null
  submitted_at: string
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  })
}

export function QuestionHistory({
  refreshKey,
  onCount
}: {
  refreshKey?: number
  /** Reports how many rows loaded, so the page can open the composer when there are none. */
  onCount?: (n: number) => void
}) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/portal/questions')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        if (j?.ok) {
          const list: Row[] = Array.isArray(j.questions) ? j.questions : []
          setRows(list)
          onCount?.(list.length)
        } else {
          setError(j?.message ?? 'Could not load your questions.')
        }
      })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [refreshKey])

  if (error) {
    return (
      <div className="surface" style={{ marginTop: 24, padding: 20 }}>
        <p style={{ fontSize: 13, color: '#991b1b', margin: 0, lineHeight: 1.6 }}>
          We could not load your past questions: {error}. This does not mean they were lost.
        </p>
      </div>
    )
  }

  // Still loading, or nothing asked yet. The page shows the composer in the empty case, so a box
  // saying "no questions" would just be in the way.
  if (rows === null || rows.length === 0) return null

  const waiting = rows.filter(r => !r.answered_at).length

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        gap: 12, marginBottom: 12, flexWrap: 'wrap'
      }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
          {rows.length} question{rows.length === 1 ? '' : 's'}
        </h2>
        {waiting > 0 && (
          <span className="subtle" style={{ fontSize: 12 }}>
            {waiting} waiting for a reply
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.map(r => (
          <div
            key={r.id}
            style={{
              padding: '14px 16px', borderRadius: 10,
              // Answered recedes, waiting stands out. Left identical there is no way to see at a
              // glance whether anything is still outstanding.
              border: r.answered_at ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(0,163,224,0.35)',
              background: r.answered_at ? 'rgba(0,0,0,0.015)' : 'rgba(0,163,224,0.04)'
            }}
          >
            {/* A status word, not just a colour. Colour alone is not a status anyone can read out
                loud, and it is invisible to a colourblind student. */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', gap: 12,
              alignItems: 'center', flexWrap: 'wrap', marginBottom: 8
            }}>
              <span style={{
                display: 'inline-block', padding: '2px 9px', borderRadius: 999,
                fontSize: 11, fontWeight: 700, letterSpacing: '0.02em',
                background: r.answered_at ? 'rgba(34,197,94,0.12)' : 'rgba(0,163,224,0.14)',
                color: r.answered_at ? '#166534' : '#0369a1'
              }}>
                {r.answered_at ? 'Answered' : 'Waiting for a reply'}
              </span>
              <span className="subtle" style={{ fontSize: 12 }}>Asked {when(r.submitted_at)}</span>
            </div>

            <div style={{
              fontSize: 14, color: '#1a1a2e', whiteSpace: 'pre-wrap', lineHeight: 1.6
            }}>
              {r.question}
            </div>

            {r.answer ? (
              <div style={{
                marginTop: 12, padding: '12px 14px', borderRadius: 8,
                background: '#fff', borderLeft: '3px solid var(--bl-blue, #0073cf)'
              }}>
                <div className="subtle" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  Bud Light U replied
                  {r.answered_at && (
                    <span style={{ fontWeight: 400 }}> · {when(r.answered_at)}</span>
                  )}
                </div>
                <div style={{
                  fontSize: 14, color: '#374151', whiteSpace: 'pre-wrap', lineHeight: 1.7
                }}>
                  {r.answer}
                </div>
              </div>
            ) : r.answered_at ? (
              /* Marked answered with no text stored: the reply went out of somebody's own email
                 client. Saying "handled" is honest; pretending there is nothing to show is not. */
              <p className="subtle" style={{ fontSize: 13, margin: '12px 0 0', lineHeight: 1.6 }}>
                Answered by email. Check your inbox, and ask again below if it did not arrive.
              </p>
            ) : (
              <p className="subtle" style={{ fontSize: 13, margin: '12px 0 0', lineHeight: 1.6 }}>
                Waiting for a reply. It will come here and to your email.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
