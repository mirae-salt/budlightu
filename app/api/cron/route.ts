/**
 * GET /api/cron  — the thing that actually runs the monthly cycle.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scheduler-audit` (15th) and `scheduler-generate` (16th) were written, tested and
 * correct, and **nothing invoked either one**. No pg_cron, no vercel.json, no
 * import, no `Deno.serve` — they were plain TypeScript modules nobody called. The
 * only way an invoice got created was as a side effect of approving a receipt,
 * which means a BAM who submitted no receipt was never invoiced and never paid
 * their salary. The 15th/16th cadence described in the docs and printed on
 * /admin/invoices could not fire.
 *
 * Vercel Cron calls this once a day and the route decides what is due today, because
 * the Hobby plan allows one daily cron rather than day-of-month schedules. The
 * schedulers take their own advisory lock, so a duplicate call is harmless.
 *
 * AUTH: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. If CRON_SECRET is
 * not set we refuse rather than running unauthenticated — this endpoint moves money
 * downstream. An admin session is also accepted so Robin can run a cycle by hand.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runDailyDigest } from '../../../lib/run-daily-digest'
import { runStudentReminders } from '../../../lib/run-student-reminders'
import { handler as runAudit } from '../../../supabase/functions/scheduler-audit/index'
import { handler as runGenerate } from '../../../supabase/functions/scheduler-generate/index'
import { runSeedInvoices as runSeed } from '../../../lib/run-seed-invoices'
import { requireAdmin } from '../../../lib/admin-auth'
import { envString } from '../../../lib/sanitize'

/**
 * Day of month each job is due.
 *
 * Receipts close on the 15th. The audit runs on the 16th, and invoices go to AP on the 17th,
 * which is the date Robin asked for.
 *
 * THE GAP BETWEEN THEM IS THE POINT. The audit flags receipts it is not sure about, and
 * clearing those is Robin's first touchpoint. Running both jobs on the same day would give
 * her zero time to do it, so anything still undecided would be left out of that month's
 * invoice and the reimbursement would be short, every month, by hand.
 *
 * Decided by Mirae on 2026-08-12. Robin's own answer was "check on the 17th, submit on the
 * 17th"; moving the check a day earlier keeps her deadline and buys back the review window.
 *
 * If these are ever set to the SAME day, the branch below must be changed too: it is an
 * else-if chain, so audit would run and generate would never fire.
 */
const SEED_DAY = 1
const AUDIT_DAY = 16
const GENERATE_DAY = 17

export const maxDuration = 300

type JobName = 'audit' | 'generate' | 'seed'

async function isAuthorized(req: NextRequest): Promise<{ ok: true; via: string } | { ok: false; status: number; message: string }> {
  const secret = envString('CRON_SECRET')
  const header = req.headers.get('authorization') ?? ''

  if (secret) {
    // Constant-time-ish compare is overkill here, but do not leak via early exit
    // on length alone.
    const expected = `Bearer ${secret}`
    if (header.length === expected.length && header === expected) return { ok: true, via: 'cron secret' }
  }

  // Fall back to an admin session so a cycle can be run by hand.
  const auth = await requireAdmin()
  if (auth.ok) return { ok: true, via: `admin ${auth.email ?? auth.userId}` }

  if (!secret) {
    // Fail closed and say why, rather than running the money cycle open to the world.
    return { ok: false, status: 503, message: 'CRON_SECRET is not configured and you are not signed in as an admin. Refusing to run.' }
  }
  return { ok: false, status: 401, message: 'Not authorized.' }
}

export async function GET(req: NextRequest) {
  const auth = await isAuthorized(req)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status })
  }

  const url = req.nextUrl
  const forced = url.searchParams.get('job')
  const period = url.searchParams.get('period') ?? undefined

  // UTC, to match lib/period.ts. A local-time day-of-month would fire on the wrong
  // date for part of every day.
  const now = new Date()
  const day = now.getUTCDate()

  // The digest runs on EVERY invocation, before the day gate, because what it reports
  // does not follow the invoice cycle: a student asks a question or files a banking
  // change whenever they like. It never throws and never blocks the money jobs, so a
  // digest failure cannot take the cycle down with it.
  let digest: Awaited<ReturnType<typeof runDailyDigest>> | { sent: false; reason: string; questions: 0; pendingBanking: 0; error?: string }
  try {
    digest = await runDailyDigest(now)
  } catch (e) {
    console.error('[cron] daily digest threw:', e)
    digest = { sent: false, reason: 'threw', questions: 0, pendingBanking: 0, error: e instanceof Error ? e.message : String(e) }
  }

  // Reminders to students, on the same every-invocation footing as the digest and for the
  // same reason: the day gate below is about the money cycle, and a reminder that only fires
  // on the 16th is not a reminder. Which days it actually sends on is its own setting, and it
  // is OFF until Robin approves the wording.
  //
  // Wrapped, because a reminder failing must never stop invoices from being generated.
  let reminders: Awaited<ReturnType<typeof runStudentReminders>> | { ran: false; mode: 'off'; note: string; considered: 0; selected: 0; sent: 0; failed: 0; errors: string[] }
  try {
    reminders = await runStudentReminders(now)
  } catch (e) {
    console.error('[cron] student reminders threw:', e)
    reminders = {
      ran: false, mode: 'off', note: `threw: ${e instanceof Error ? e.message : String(e)}`,
      considered: 0, selected: 0, sent: 0, failed: 0, errors: []
    }
  }

  let jobs: JobName[]
  if (forced === 'audit' || forced === 'generate') {
    jobs = [forced]
  } else if (forced === 'both') {
    jobs = ['audit', 'generate']
  } else if (forced === 'seed') {
    jobs = ['seed']
  } else if (forced) {
    return NextResponse.json({ ok: false, message: `unknown job "${forced}" (use seed, audit, generate or both)` }, { status: 400 })
  } else if (day === SEED_DAY) {
    /*
     * Day one: every active BAM gets that month's draft invoice, so Robin and Janet can
     * put a bar tab or an Uber on it before any receipt exists. Janet asked for this on
     * 2026-09-04; without it the only editable invoices were the ones a receipt had
     * already created.
     *
     * It sits ahead of AUDIT_DAY in this chain for the same reason those two are
     * separate days: one branch, one job, and adding a day must not shadow another.
     */
    jobs = ['seed']
  } else if (day === AUDIT_DAY) {
    jobs = ['audit']
  } else if (day === GENERATE_DAY) {
    jobs = ['generate']
  } else {
    // Not a failure: most days nothing is due. Say so explicitly so a green cron
    // log is not mistaken for "the cycle ran".
    return NextResponse.json({
      ok: true,
      ran: [],
      digest,
      reminders,
      note: `nothing due on day ${day} (invoices seeded on the ${SEED_DAY}st, audit on the ${AUDIT_DAY}th, generate on the ${GENERATE_DAY}th, UTC)`,
      authorized_via: auth.via
    })
  }

  const results: Array<{ job: JobName; ok: boolean; result?: unknown; error?: string }> = []

  for (const job of jobs) {
    try {
      const out = job === 'seed'
        ? await runSeed({ period })
        : job === 'audit' ? await runAudit({ period }) : await runGenerate({ period })
      // Both handlers return { ok: errors.length === 0, ... }, so a partial failure
      // is already reported honestly. Pass it through rather than flattening it.
      results.push({ job, ok: Boolean((out as { ok?: boolean })?.ok), result: out })
    } catch (e) {
      results.push({ job, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const allOk = results.every(r => r.ok)
  return NextResponse.json({
    ok: allOk,
    ran: jobs,
    // Reported on both paths so a green cron log can never hide whether the digest ran.
    digest,
    reminders,
    authorized_via: auth.via,
    results,
    ...(allOk ? {} : { message: 'One or more jobs reported errors. See results.' })
  }, { status: allOk ? 200 : 500 })
}
