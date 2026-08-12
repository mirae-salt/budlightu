/**
 * GET /api/admin/nav-counts — how many items are waiting in each admin queue.
 *
 * Feeds the sidebar badges. Unmatched receipts and banking changes are queues that are
 * empty most of the time, so they sat in the nav looking like permanent features of the
 * program rather than "something needs you". With a count they recede when there is nothing
 * and stand out when there is.
 *
 * They are still LISTED when the count is zero, deliberately. Hiding them would make them
 * unreachable: nothing else in the app links to either page, so a hidden queue is a queue
 * whose history nobody can look up.
 *
 * A count that cannot be read comes back as null and renders as NO badge. Showing 0 for a
 * failed read is the one wrong answer here, because 0 is exactly the value that means
 * "nothing to do". These table and column names were checked against the live database by
 * scripts/probe/nav-count-columns.js -- the first draft of this file guessed
 * `bam_banking_requests` and `portal_questions.answered_at`, and neither exists.
 */
import { NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../lib/admin-auth'

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: true, counts: {} })
  }

  const [unmatchedRes, bankingRes, questionsRes] = await Promise.all([
    db.from('receipts').select('id', { count: 'exact', head: true }).is('bam_id', null),
    db.from('banking_change_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    // Migration 0026 added answered_at, so "unanswered" is finally a real thing to count.
    // Before it, the only available number was the total, which would have badged 1 forever.
    db.from('portal_questions').select('id', { count: 'exact', head: true }).is('answered_at', null)
  ])

  if (unmatchedRes.error) console.error('[nav-counts] unmatched failed:', unmatchedRes.error.message)
  if (bankingRes.error) console.error('[nav-counts] banking failed:', bankingRes.error.message)
  if (questionsRes.error) console.error('[nav-counts] questions failed:', questionsRes.error.message)

  return NextResponse.json({
    ok: true,
    counts: {
      // null, not 0, on failure. `count` also comes back null with no error when the table
      // name is wrong, so null is treated as unknown either way.
      unmatched: unmatchedRes.error ? null : unmatchedRes.count,
      banking: bankingRes.error ? null : bankingRes.count,
      questions: questionsRes.error ? null : questionsRes.count
    }
  })
}
