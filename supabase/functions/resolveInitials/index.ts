/**
 * Edge Function: resolveInitials
 * POST { cohort_id: string }
 *
 * Called on cohort activation. Reads active + pending BAMs, runs the
 * collision-resolution algorithm from lib/initials.ts, and writes back
 * the resolved value per BAM. Enforced at DB level by
 * UNIQUE (cohort_id, initials_resolved).
 */
import { serviceClient } from '../_shared/supabase-admin'
import { resolveInitials } from '../../../lib/initials'

export async function handler(req: { cohort_id: string }) {
  const db = serviceClient()
  const { data: bams, error } = await db.from('bams')
    .select('id, first_name, last_name')
    .eq('cohort_id', req.cohort_id)
    .in('status', ['pending', 'active'])
  if (error) return { ok: false, error: error.message }
  if (!bams?.length) return { ok: true, updated: 0 }

  const resolved = resolveInitials(bams.map(b => ({
    id: b.id, firstName: b.first_name, lastName: b.last_name
  })))

  let updated = 0
  for (const r of resolved) {
    const { error: upErr } = await db.from('bams')
      .update({ initials_resolved: r.initials })
      .eq('id', r.bamId)
    if (upErr) return { ok: false, error: `update ${r.bamId} failed: ${upErr.message}` }
    updated++
  }

  await db.from('audit_log').insert({
    actor_role: 'system', entity: 'cohorts', entity_id: req.cohort_id,
    action: 'initials_resolved', after_json: resolved
  })

  return { ok: true, updated }
}
