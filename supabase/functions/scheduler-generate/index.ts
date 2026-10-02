/**
 * Edge Function: scheduler-generate (invoked by /api/cron on the 17th)
 *
 * For every active cohort:
 *   1. Advisory-lock the run
 *   2. For each active BAM: generate invoice payload → insert invoices row (status=draft)
 *      → render PDF (calls renderInvoicePdf; not yet implemented here)
 *      → queue three sends (AP, SharePoint, BAM copy) — all in draft/dryrun by default
 *   3. Program admin approves batch in admin UI → flips to sent
 *
 * Nothing goes live in this scheduler run — that's the batch-approve step.
 *
 * AUDIT-2026-08-07 fixes:
 *  - P1-7: the per-BAM body is wrapped in try/catch. formatInvoiceNumber throws
 *    on unusable initials (mononyms, names with no Latin letters) and there was
 *    no catch here, so ONE bad roster row aborted the entire monthly run after
 *    the lock had been taken — every remaining BAM silently got no invoice.
 *  - P0-H: the lock RPC and both reads now check `error` instead of failing open.
 *  - P1-3: the lock is REAL now. `try_scheduler_lock` used
 *    pg_try_advisory_xact_lock, which is transaction-scoped, and a PostgREST RPC
 *    commits immediately, so the lock was released before any work started and
 *    two concurrent runs both proceeded. Worse, the caller did
 *    `const { data: locked }` with no error check and compared `locked === false`,
 *    so both an errored RPC and a `null` result failed OPEN. It now uses
 *    acquire_scheduler_lock (a lock ROW with a TTL, 0017_receipt_ai_fixes.sql),
 *    treats ANY error as "did not acquire", requires locked === true, and
 *    releases in a finally. Matches scheduler-audit.
 */
import { serviceClient } from '../_shared/supabase-admin'
import { handler as genPayload } from '../generateInvoicePayload/index'

const LOCK_TTL_SECONDS = 900

export async function handler(req: { period?: string } = {}) {
  const db = serviceClient()
  const period = req.period ?? firstOfCurrentMonth()
  const jobName = `generate-${period}`

  const { data: locked, error: lockErr } = await db.rpc('acquire_scheduler_lock', {
    p_job_name: jobName,
    p_ttl_seconds: LOCK_TTL_SECONDS,
    p_holder: `scheduler-generate@${new Date().toISOString()}`
  })
  if (lockErr) {
    // Fail CLOSED: an unknown lock state means we do not know whether another run
    // is live, and generating a month's invoices twice is a money bug.
    return { ok: false, error: `could not acquire the generate lock: ${lockErr.message}` }
  }
  if (locked !== true) {
    return { ok: false, error: 'another generate run holds the lock — skipping' }
  }

  try {
    return await runGenerate(db, period)
  } finally {
    const { error: relErr } = await db.rpc('release_scheduler_lock', { p_job_name: jobName })
    if (relErr) {
      console.error('[scheduler-generate] could not release lock', jobName, relErr.message,
        `- it expires automatically in ${LOCK_TTL_SECONDS}s`)
    }
  }
}

async function runGenerate(db: ReturnType<typeof serviceClient>, period: string) {
  const { data: cohorts, error: cohortErr } = await db.from('cohorts').select('*')
    .lte('start_date', period).gte('end_date', period)
  if (cohortErr) return { ok: false, error: `cohorts read failed: ${cohortErr.message}` }
  if (!cohorts?.length) return { ok: true, generated: 0, errors: [] as string[] }

  let generated = 0
  let skipped = 0
  const errors: string[] = []

  for (const cohort of cohorts) {
    const { data: bams, error: bamErr } = await db.from('bams')
      .select('id').eq('cohort_id', cohort.id).eq('status', 'active')
    if (bamErr) {
      errors.push(`cohort ${cohort.id}: bams read failed: ${bamErr.message}`)
      continue
    }

    for (const bam of bams ?? []) {
      // One bad row must never take down the run for the other 57 BAMs.
      try {
        const res = await genPayload({ bam_id: bam.id, period })
        if (!res.ok) {
          if ('existing_invoice_id' in res && res.existing_invoice_id) skipped++
          else errors.push(`${bam.id}: ${res.error}`)
          continue
        }

        const { error: insErr } = await db.from('invoices').insert({
          bam_id: bam.id,
          cohort_id: cohort.id,
          period,
          seq: res.seq,
          revision: res.revision,
          invoice_number: res.invoice_number,
          payload_json: res.payload,
          status: 'draft',
          currency: 'CAD'
        })
        if (insErr) { errors.push(`${bam.id}: invoice insert failed: ${insErr.message}`); continue }

        generated++
      } catch (e) {
        errors.push(`${bam.id}: unhandled ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // CRITIC GATE 2026-08-07 F12: this used to be a hardcoded `ok: true`, so a run
  // where all 58 generations failed reported a clean success and nobody looked at
  // `errors`. Mirrors scheduler-audit: any per-BAM error fails the run.
  return { ok: errors.length === 0, generated, skipped, errors }
}

function firstOfCurrentMonth(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-01`
}
