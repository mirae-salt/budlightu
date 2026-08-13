/**
 * Q: When their invoice goes out, which students actually receive a copy of it?
 *
 * WHY THIS MATTERS MORE THAN IT USED TO
 * -------------------------------------
 * There are two ways a student can end up holding their own invoice:
 *
 *   1. CC'd on the email to accounts payable   gated by lib/bam-cc.ts
 *   2. A dedicated copy (sendBamCopy)          gated by cohorts.bam_copy_mode
 *
 * Mirae, 2026-08-13: the CC already carries the same PDF, so the dedicated copy is redundant
 * and `bam_copy_mode` was turned off. That is a reasonable call, and it makes the CC the ONLY
 * channel. A student who fails its gate now receives nothing at all, and the only trace is a
 * warning on the send result that nobody reads after a successful batch.
 *
 * So this answers the question the send result buries: who gets nothing, and why.
 *
 * The CC needs BOTH a verified email (they completed an OTP login, so the address provably
 * reaches them) and consent_ap_cc. The invoice PDF contains a home address and a full bank
 * account number, which is why the bar is there and should stay.
 *
 * Usage: node scripts/probe/invoice-copy-reach.js
 */
const { serviceClient, loadTs, pass, fail, info, verdict } = require('./_lib')

async function main() {
  const db = serviceClient()
  const { bamCcProblem } = loadTs('lib/bam-cc.ts')

  const { data: cohorts, error: cErr } = await db
    .from('cohorts').select('id, name, bam_copy_mode, send_mode')
  if (cErr) { fail(`cohorts unreadable: ${cErr.message}`); return verdict('invoice copy reach') }

  const byId = new Map((cohorts ?? []).map(c => [c.id, c]))
  for (const c of cohorts ?? []) {
    info(`cohort ${String(c.name).padEnd(12)} send_mode=${c.send_mode} bam_copy_mode=${c.bam_copy_mode}` +
      (c.bam_copy_mode === 'off' ? '  (CC is the only channel)' : ''))
  }

  const { data: bams, error } = await db
    .from('bams')
    .select('email, first_name, last_name, status, is_test, cohort_id, email_verified_at, consent_ap_cc')
    .eq('status', 'active')
    .order('email')
  if (error) { fail(`bams unreadable: ${error.message}`); return verdict('invoice copy reach') }

  let reachable = 0
  const unreachable = []

  for (const b of bams ?? []) {
    const problem = bamCcProblem(b)
    const cohort = byId.get(b.cohort_id)
    // A dedicated copy still going out is a second chance; note it rather than ignore it.
    const copyOn = cohort && cohort.bam_copy_mode !== 'off'

    if (!problem) {
      reachable++
      continue
    }
    unreachable.push({ email: b.email, problem, copyOn, isTest: b.is_test })
  }

  if (unreachable.length === 0) {
    pass(`all ${reachable} active students would receive their invoice`)
  } else {
    pass(`${reachable} student(s) would receive their invoice`)
    for (const u of unreachable) {
      const short = String(u.problem).replace(/^BAM not CC'd: /, '').split('.')[0]
      const line = `${String(u.email).padEnd(32)} would get NOTHING: ${short}`
      // Not a hard failure for a test row: those are ours and nobody is waiting to be paid.
      if (u.isTest) info(`${line}  (test account)`)
      else fail(line)
    }
  }

  info('the AP email itself is never blocked by this; only the student\'s copy of it')
  info('read-only: nothing was written')
  verdict('invoice copy reach')
}
main()
