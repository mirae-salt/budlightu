/**
 * Q: For each parked onboarding submission, can the server unambiguously work
 *    out WHICH roster row it was meant for?
 *
 * /admin/unmatched "Fix roster" used to set status='resolved' and nothing else,
 * so the only record that anyone had to act on disappeared while the student
 * stayed locked out. The replacement route (POST /api/admin/unmatched/resolve)
 * refuses rather than guesses, and this probe says in advance whether it will be
 * able to act on the rows that exist right now.
 *
 * Resolution order, same as lib/unmatched-resolve.ts:
 *   1. matched_bam_id, if already set
 *   2. the `roster=<email>` fragment that onboarding-ingest writes into
 *      flag_reason, looked up against bams (must hit exactly one row)
 *
 * PRIVACY: prints ids, counts and shapes only. No email, name or address value
 * is ever printed, and it never touches the banking columns or the decrypt RPCs.
 *
 * BLIND SPOT: service role, so this says nothing about whether a program_admin
 * would be allowed to do the same reads (onboarding_submissions is
 * super-admin-only under RLS — that is exactly why the fix moved the write to a
 * server route). It also cannot tell you whether the roster email or the
 * submitted email is the CORRECT one; only a human knows that.
 *
 * Usage: node scripts/probe/unmatched-resolvable.js
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

/** Keep in sync with lib/unmatched-resolve.ts ROSTER_EMAIL_RE. */
const ROSTER_EMAIL_RE = /roster\s*=\s*([^\s,;]+)/i

async function main() {
  const db = serviceClient()

  const { data, error } = await db
    .from('onboarding_submissions')
    .select('id, status, matched_bam_id, flag_reason, submitted_email')
    .eq('status', 'unmatched')

  if (error) {
    fail(`onboarding_submissions unreadable: ${error.message}`)
    return verdict('unmatched resolvable')
  }

  const rows = data || []
  info(`${rows.length} submission(s) with status='unmatched'`)
  if (rows.length === 0) {
    pass('nothing parked, nothing to resolve')
    return verdict('unmatched resolvable')
  }

  for (const row of rows) {
    if (row.matched_bam_id) {
      pass(`${row.id}  already linked to bam ${row.matched_bam_id}`)
      continue
    }

    const m = ROSTER_EMAIL_RE.exec(row.flag_reason || '')
    if (!m) {
      fail(`${row.id}  flag_reason has no "roster=" fragment (len ${(row.flag_reason || '').length}) -> route will refuse`)
      continue
    }

    const rosterEmail = m[1].trim().toLowerCase()
    const { data: hits, error: bErr } = await db
      .from('bams')
      .select('id, status')
      .ilike('email', rosterEmail)
      .limit(3)

    if (bErr) {
      fail(`${row.id}  roster lookup failed: ${bErr.message}`)
      continue
    }
    if (!hits || hits.length === 0) {
      fail(`${row.id}  roster= email matches 0 bams -> route will refuse`)
      continue
    }
    if (hits.length > 1) {
      fail(`${row.id}  roster= email matches ${hits.length} bams -> route will refuse (ambiguous)`)
      continue
    }
    const submittedSameAsRoster =
      (row.submitted_email || '').trim().toLowerCase() === rosterEmail
    pass(
      `${row.id}  -> bam ${hits[0].id} (status=${hits[0].status})` +
      (submittedSameAsRoster ? ' [submitted == roster, no email change needed]' : '')
    )
  }

  verdict('unmatched resolvable')
}
main()
