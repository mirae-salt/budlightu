/**
 * P0-1 fix: initials collision resolution for INV-XX numbering.
 *
 * Real case (from DESIGN-NOTES §0): Lucas Grabowski + Luke Grabowski = both "LG".
 * Simple initials risk generating the same invoice_number → AP dedup mispay.
 *
 * Strategy: at cohort activation, compute base initials for all BAMs; for each
 * collision group, escalate to a longer form until unique. Store the resolved
 * value on the BAM row. Enforced by DB UNIQUE (cohort_id, initials_resolved).
 */

export type Bam = { id: string; firstName: string; lastName: string }
export type ResolvedInitials = { bamId: string; initials: string }

function firstNLetters(word: string, n: number): string {
  return (word || '').replace(/[^A-Za-z]/g, '').slice(0, n).toUpperCase()
}

/** Base = first letter of first name + first letter of last name. */
export function baseInitials(bam: Pick<Bam, 'firstName' | 'lastName'>): string {
  return firstNLetters(bam.firstName, 1) + firstNLetters(bam.lastName, 1)
}

/**
 * Given a cohort's BAM roster, return a map of bam.id → unique initials.
 * Escalation ladder for a collision group:
 *   1) firstLetter(first) + first2Letters(last)      e.g. "LGR"
 *   2) first2Letters(first) + first2Letters(last)    e.g. "LUGR"
 *   3) first3Letters(first) + first2Letters(last)    e.g. "LUCGR"
 *   4) full first name upper + firstLetter(last)     e.g. "LUCASG"
 *   5) throw — human admin required.
 */
export function resolveInitials(bams: Bam[]): ResolvedInitials[] {
  // Bucket by base initials
  const buckets = new Map<string, Bam[]>()
  for (const b of bams) {
    const k = baseInitials(b)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k)!.push(b)
  }

  const result: ResolvedInitials[] = []

  for (const [_base, group] of buckets) {
    if (group.length === 1) {
      result.push({ bamId: group[0].id, initials: baseInitials(group[0]) })
      continue
    }

    // collision — walk the ladder
    const attempts: Array<(b: Bam) => string> = [
      b => firstNLetters(b.firstName, 1) + firstNLetters(b.lastName, 2),
      b => firstNLetters(b.firstName, 2) + firstNLetters(b.lastName, 2),
      b => firstNLetters(b.firstName, 3) + firstNLetters(b.lastName, 2),
      b => firstNLetters(b.firstName, 5) + firstNLetters(b.lastName, 1)
    ]

    let resolved = false
    for (const fn of attempts) {
      const proposed = group.map(b => ({ bam: b, initials: fn(b) }))
      const set = new Set(proposed.map(p => p.initials))
      if (set.size === proposed.length) {
        for (const p of proposed) result.push({ bamId: p.bam.id, initials: p.initials })
        resolved = true
        break
      }
    }

    if (!resolved) {
      const names = group.map(b => `${b.firstName} ${b.lastName}`).join(', ')
      throw new Error(
        `Unresolvable initials collision for cohort BAMs: ${names}. Admin must set initials manually.`
      )
    }
  }

  return result
}
