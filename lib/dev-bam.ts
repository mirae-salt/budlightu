/**
 * Which BAM the dev bypass acts as.
 *
 * WHY THIS IS SHARED AND ORDERED
 * ------------------------------
 * Two things went wrong on 2026-08-13, both of them only in dev, and both of them made a working
 * feature look broken:
 *
 * 1. `/api/portal/support` resolved no BAM at all under the bypass, so a question submitted in dev
 *    was stored with `bam_id: null`. Orphaned: the tracker cannot show it to anybody, because there
 *    is nobody it belongs to.
 * 2. `/api/portal/reminders` and `/api/portal/questions` each did their own
 *    `.eq('is_test', true).limit(1)` with no ORDER BY. Postgres is under no obligation to return the
 *    same row twice, so one route could write as one test BAM while another read as a different one.
 *
 * So: one helper, ordered by email, used by every portal route's bypass. Ordering is the whole point
 * of the function; `limit(1)` without it is a coin flip that only shows up as "the feature does not
 * work" much later.
 *
 * `is_test` only, and never a real student's row. In production none of this runs: the bypass needs
 * NODE_ENV=development AND the explicit opt-in flag (see lib/admin-auth.ts isDevBypass).
 */
import type { serviceClient } from '../supabase/functions/_shared/supabase-admin'

export type DevBam = {
  id: string
  email: string | null
  first_name: string | null
}

/**
 * The one test BAM the dev bypass speaks for, or null when there is none.
 *
 * Returning null rather than throwing: a dev environment with no TEST cohort should degrade to
 * "nothing to show", not to a 500 on every portal page.
 */
export async function devBypassBam(
  db: ReturnType<typeof serviceClient>
): Promise<DevBam | null> {
  const { data, error } = await db
    .from('bams')
    .select('id, email, first_name')
    .eq('is_test', true)
    .eq('status', 'active')
    // DETERMINISTIC. See the header: without this, two routes can disagree about who they are.
    .order('email', { ascending: true })
    .limit(1)

  if (error) {
    console.error('[dev-bam] lookup failed:', error.message)
    return null
  }
  return ((data ?? [])[0] as DevBam | undefined) ?? null
}
