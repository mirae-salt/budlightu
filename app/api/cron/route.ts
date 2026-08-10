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
import { handler as runAudit } from '../../../supabase/functions/scheduler-audit/index'
import { handler as runGenerate } from '../../../supabase/functions/scheduler-generate/index'
import { requireAdmin } from '../../../lib/admin-auth'
import { envString } from '../../../lib/sanitize'

/** Day of month each job is due. Receipts close on the 15th; invoices follow on the 16th. */
const AUDIT_DAY = 15
const GENERATE_DAY = 16

export const maxDuration = 300

type JobName = 'audit' | 'generate'

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

  let jobs: JobName[]
  if (forced === 'audit' || forced === 'generate') {
    jobs = [forced]
  } else if (forced === 'both') {
    jobs = ['audit', 'generate']
  } else if (forced) {
    return NextResponse.json({ ok: false, message: `unknown job "${forced}" (use audit, generate or both)` }, { status: 400 })
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
      note: `nothing due on day ${day} (audit runs on the ${AUDIT_DAY}th, generate on the ${GENERATE_DAY}th, UTC)`,
      authorized_via: auth.via
    })
  }

  const results: Array<{ job: JobName; ok: boolean; result?: unknown; error?: string }> = []

  for (const job of jobs) {
    try {
      const out = job === 'audit' ? await runAudit({ period }) : await runGenerate({ period })
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
    authorized_via: auth.via,
    results,
    ...(allOk ? {} : { message: 'One or more jobs reported errors. See results.' })
  }, { status: allOk ? 200 : 500 })
}
