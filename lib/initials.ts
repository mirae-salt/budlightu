/**
 * P0-1 fix: initials collision resolution for INV-XX numbering.
 *
 * Real case (from DESIGN-NOTES §0): Lucas Grabowski + Luke Grabowski = both "LG".
 * Simple initials risk generating the same invoice_number → AP dedup mispay.
 *
 * Strategy: at cohort activation, compute base initials for all BAMs; for each
 * collision group, escalate to a longer form until unique. Store the resolved
 * value on the BAM row. Enforced by DB UNIQUE (cohort_id, initials_resolved).
 *
 * P1-7 fix (audit 2026-08-07): accents are now *folded*, not deleted.
 * `.replace(/[^A-Za-z]/g,'')` alone turned "Émile Côté" into "MC" (the accented
 * first letter vanished and the second letter was promoted). NFD decomposition
 * first splits "É" into "E" + combining acute, so stripping non-Latin letters
 * leaves the "E". Names with no Latin letters at all (mononyms, CJK) used to
 * yield <2 characters and made formatInvoiceNumber throw; they now get a
 * deterministic code. Every value returned from this module satisfies
 * formatInvoiceNumber's /^[A-Z]{2,10}$/.
 */

export type Bam = { id: string; firstName: string; lastName: string }
export type ResolvedInitials = { bamId: string; initials: string }

/** Must stay in sync with lib/invoice-numbering.ts formatInvoiceNumber. */
const VALID_INITIALS = /^[A-Z]{2,10}$/

/**
 * NFC → NFD → keep Latin letters only → uppercase.
 * "Émile" → "E", "Côté" → "COTE", "Michał" → "MICHA" (ł has no decomposition).
 */
export function foldLatinLetters(word: string): string {
  return (word || '')
    .normalize('NFC')
    .normalize('NFD')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
}

function firstNLetters(word: string, n: number): string {
  return foldLatinLetters(word).slice(0, n)
}

/** Deterministic letters from a name, for names with no usable Latin letters. */
function hashLetters(seed: string, count: number): string {
  // FNV-1a over the NFC form: same name in, same code out, forever.
  let h = 0x811c9dc5
  for (const ch of seed.normalize('NFC')) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  let out = ''
  for (let i = 0; i < count; i++) {
    out += String.fromCharCode(65 + (h % 26))
    h = Math.floor(h / 26) + 7
  }
  return out
}

/**
 * Base = first letter of first name + first letter of last name.
 * Guaranteed to be 2–3 uppercase A–Z letters even for names with no Latin
 * letters, so it can never make formatInvoiceNumber throw.
 */
export function baseInitials(bam: Pick<Bam, 'firstName' | 'lastName'>): string {
  const first = foldLatinLetters(bam.firstName)
  const last = foldLatinLetters(bam.lastName)

  const straightforward = first.slice(0, 1) + last.slice(0, 1)
  if (straightforward.length === 2) return straightforward

  // One of the two name parts has no Latin letters (mononym, empty last name,
  // CJK/Cyrillic script). Fall back deterministically instead of shipping a
  // 1-character value or "AUNDEFINED" (the old draft-invoice.ts behaviour).
  const all = first + last
  const seed = `${bam.firstName ?? ''} ${bam.lastName ?? ''}`
  if (all.length >= 2) return all.slice(0, 2)
  if (all.length === 1) return all + hashLetters(seed, 1)
  return `X${hashLetters(seed, 2)}`
}

/**
 * Given a cohort's BAM roster, return a map of bam.id → unique initials.
 * Escalation ladder for a collision group:
 *   1) firstLetter(first) + first2Letters(last)      e.g. "LGR"
 *   2) first2Letters(first) + first2Letters(last)    e.g. "LUGR"
 *   3) first3Letters(first) + first2Letters(last)    e.g. "LUCGR"
 *   4) full first name upper + firstLetter(last)     e.g. "LUCASG"
 *   5) base + a letter suffix (AK + A/B/C…) — always valid for numbering.
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
      // A rung that produces an invalid value (too short — e.g. a name with no
      // Latin letters) is skipped rather than shipped: formatInvoiceNumber
      // would throw on it and abort the whole monthly run.
      if (!proposed.every(p => VALID_INITIALS.test(p.initials))) continue
      const set = new Set(proposed.map(p => p.initials))
      if (set.size === proposed.length) {
        for (const p of proposed) result.push({ bamId: p.bam.id, initials: p.initials })
        resolved = true
        break
      }
    }

    if (!resolved) {
      // Identical (or unusable) names. Suffix with LETTERS, not digits: the old
      // "AK1"/"AK2" fallback was rejected by formatInvoiceNumber's
      // /^[A-Z]{2,10}$/, so the documented fallback could never produce an
      // invoice at all (P1-7/P1-8).
      const base = baseInitials(group[0])
      for (let idx = 0; idx < group.length; idx++) {
        result.push({ bamId: group[idx].id, initials: `${base}${letterSuffix(idx)}` })
      }
    }
  }

  return dedupeAcrossBuckets(result)
}

/** 0→A, 1→B, … 25→Z, 26→AA. Letters only, so numbering never breaks. */
function letterSuffix(idx: number): string {
  let n = idx
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * The ladder guarantees uniqueness inside a collision group, but two different
 * groups can in principle escalate onto the same string. DB UNIQUE
 * (cohort_id, initials_resolved) would reject that at write time, which reads as
 * a mystery failure, so settle it here instead.
 */
function dedupeAcrossBuckets(result: ResolvedInitials[]): ResolvedInitials[] {
  const taken = new Set<string>()
  return result.map(r => {
    if (!taken.has(r.initials)) {
      taken.add(r.initials)
      return r
    }
    for (let idx = 0; idx < 26 * 27; idx++) {
      const candidate = `${r.initials}${letterSuffix(idx)}`
      if (candidate.length <= 10 && !taken.has(candidate)) {
        taken.add(candidate)
        return { bamId: r.bamId, initials: candidate }
      }
    }
    throw new Error(`cannot make initials unique for bam ${r.bamId} (base ${r.initials}) — admin must set initials_resolved by hand`)
  })
}

/** True when a stored initials_resolved value can be used for numbering. */
export function isUsableInitials(v: unknown): v is string {
  return typeof v === 'string' && VALID_INITIALS.test(v)
}
