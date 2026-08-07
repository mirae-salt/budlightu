/**
 * P1-11 fix: make initials resolution happen on a path that actually runs.
 *
 * The resolveInitials Edge Function has zero callers, so any BAM created outside
 * the bulk-invite flow (single invite, manual roster add) kept
 * initials_resolved = NULL. That NULL is what pushed draft-invoice.ts onto its
 * ad-hoc `${first[0]}${last[0]}` fallback, which produced "AUNDEFINED" for an
 * empty last name and shipped INV-AUNDEFINED1.
 *
 * This resolves-on-demand, right before numbering, against the BAMs already
 * persisted in the cohort. It never rewrites another BAM's stored value (an
 * invoice already sent to AP carries that value), it only picks a free one for
 * the BAM in front of us.
 */
import { baseInitials, foldLatinLetters, isUsableInitials } from './initials'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InitialsDb = { from: (...args: any[]) => any }

export type EnsureInitialsResult =
  | { ok: true; initials: string; created: boolean }
  | { ok: false; error: string }

type BamRow = {
  id: string
  first_name: string | null
  last_name: string | null
  initials_resolved: string | null
}

const MAX_ATTEMPTS = 6

export async function ensureInitialsResolved(
  db: InitialsDb,
  bamId: string,
  cohortId: string
): Promise<EnsureInitialsResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data, error } = await db
      .from('bams')
      .select('id, first_name, last_name, initials_resolved')
      .eq('cohort_id', cohortId)

    if (error) return { ok: false, error: `bams read failed while resolving initials: ${error.message}` }

    const rows: BamRow[] = data ?? []
    const me = rows.find(r => r.id === bamId)
    if (!me) {
      return { ok: false, error: `bam ${bamId} is not in cohort ${cohortId} — refusing to number an invoice for it` }
    }

    if (isUsableInitials(me.initials_resolved)) {
      return { ok: true, initials: me.initials_resolved, created: false }
    }

    const taken = new Set(
      rows.filter(r => r.id !== bamId && isUsableInitials(r.initials_resolved)).map(r => r.initials_resolved as string)
    )

    const candidate = pickFreeInitials(me, taken)
    if (!candidate) {
      return {
        ok: false,
        error: `could not find free initials for bam ${bamId} in cohort ${cohortId} — an admin must set initials_resolved manually`
      }
    }

    // Compare-and-set against exactly what we read, so a concurrent writer
    // cannot be clobbered. The stored value may be non-null but unusable
    // (e.g. a legacy "AK1" from the old numeric fallback, which
    // formatInvoiceNumber rejects) — that gets replaced.
    let claim = db
      .from('bams')
      .update({ initials_resolved: candidate })
      .eq('id', bamId)
    claim = me.initials_resolved === null || me.initials_resolved === undefined
      ? claim.is('initials_resolved', null)
      : claim.eq('initials_resolved', me.initials_resolved)

    const { data: updated, error: upErr } = await claim.select('id, initials_resolved')

    if (upErr) {
      // Most likely UNIQUE (cohort_id, initials_resolved) — someone took it
      // between the read and the write. Re-read and try the next candidate.
      if (attempt === MAX_ATTEMPTS - 1) {
        return { ok: false, error: `initials_resolved write failed: ${upErr.message}` }
      }
      continue
    }

    const row = (updated ?? [])[0]
    if (row && isUsableInitials(row.initials_resolved)) {
      return { ok: true, initials: row.initials_resolved, created: true }
    }
    // 0 rows: another worker set it first. Loop re-reads and returns theirs.
  }

  return { ok: false, error: `initials resolution for bam ${bamId} did not settle after ${MAX_ATTEMPTS} attempts` }
}

/** Same ladder as resolveInitials, but skipping values already persisted. */
function pickFreeInitials(bam: BamRow, taken: Set<string>): string | null {
  const first = bam.first_name ?? ''
  const last = bam.last_name ?? ''
  const f = foldLatinLetters(first)
  const l = foldLatinLetters(last)
  const base = baseInitials({ firstName: first, lastName: last })

  const ladder = [
    base,
    f.slice(0, 1) + l.slice(0, 2),
    f.slice(0, 2) + l.slice(0, 2),
    f.slice(0, 3) + l.slice(0, 2),
    f.slice(0, 5) + l.slice(0, 1)
  ]

  for (const candidate of ladder) {
    if (isUsableInitials(candidate) && !taken.has(candidate)) return candidate
  }

  for (let i = 0; i < 26; i++) {
    const candidate = `${base}${String.fromCharCode(65 + i)}`
    if (isUsableInitials(candidate) && !taken.has(candidate)) return candidate
  }
  return null
}
