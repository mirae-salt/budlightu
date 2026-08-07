/**
 * Canadian bank institution number lookup.
 * All values are strings — leading zeros are load-bearing.
 * Bank list sourced from Interac Sign-In partners (2026).
 * Seed data mirrored in supabase/migrations/0005_seed_banks.sql.
 */

import { stripInvisible } from './sanitize'

export type BankLookup = { normalized: string; institutionNo: string; displayName: string }

export const BANK_SEED: BankLookup[] = [
  { normalized: 'affinity',          institutionNo: '839', displayName: 'Affinity Credit Union' },
  { normalized: 'atb',               institutionNo: '219', displayName: 'ATB Financial' },
  { normalized: 'bmo',               institutionNo: '001', displayName: 'BMO Bank of Montreal' },
  { normalized: 'caisse alliance',   institutionNo: '815', displayName: 'Caisse Alliance' },
  { normalized: 'cibc',              institutionNo: '010', displayName: 'CIBC' },
  { normalized: 'coast capital',     institutionNo: '809', displayName: 'Coast Capital Savings' },
  { normalized: 'conexus',           institutionNo: '839', displayName: 'Conexus Credit Union' },
  { normalized: 'connectfirst',      institutionNo: '839', displayName: 'connectFirst Credit Union' },
  { normalized: 'desjardins',        institutionNo: '815', displayName: 'Desjardins' },
  { normalized: 'libro',             institutionNo: '839', displayName: 'Libro Credit Union' },
  { normalized: 'meridian',          institutionNo: '839', displayName: 'Meridian Credit Union' },
  { normalized: 'national',          institutionNo: '006', displayName: 'National Bank of Canada' },
  { normalized: 'rbc',               institutionNo: '003', displayName: 'RBC Royal Bank' },
  { normalized: 'scotiabank',        institutionNo: '002', displayName: 'Scotiabank' },
  { normalized: 'scu',               institutionNo: '839', displayName: 'SCU (Steinbach Credit Union)' },
  { normalized: 'servus',            institutionNo: '839', displayName: 'Servus Credit Union' },
  { normalized: 'simplii',           institutionNo: '010', displayName: 'Simplii Financial' },
  { normalized: 'tangerine',         institutionNo: '614', displayName: 'Tangerine' },
  { normalized: 'td',                institutionNo: '004', displayName: 'TD Canada Trust' },
  { normalized: 'uni',               institutionNo: '815', displayName: 'UNI Financial Cooperation' },
  { normalized: 'vancity',           institutionNo: '809', displayName: 'Vancity' },
  { normalized: 'wealthsimple',      institutionNo: '703', displayName: 'Wealthsimple' },
]

/**
 * Explicit aliases. P1-28: lookup used to accept a SUBSTRING match, so
 * "Community Savings Credit Union" normalized to "community" ... no:
 * it normalized to "community" only after "savings" and "credit union" were
 * stripped, and "uni" is a substring of nothing there, but
 * "Uni-Financial", "Beau-Uni" and above all "Community Savings" style names
 * containing "uni" (for example "Unity Credit Union" -> "unity") matched the
 * "uni" seed and silently returned UNI Financial (815). A wrong institution
 * number is a wrong bank, which is a misdirected direct deposit.
 *
 * Matching is now EXACT against `normalized` or against one of these aliases.
 * Anything else returns null and the caller hard-fails, which is the correct
 * direction: Robin fixes the roster, we never guess a routing number.
 *
 * Add real-world spellings here as they appear. Keep the value equal to the
 * `normalized` key of a BANK_SEED entry.
 */
export const BANK_ALIASES: Record<string, string> = {
  // RBC
  'royal': 'rbc',
  'royal of canada': 'rbc',
  'rbc royal': 'rbc',
  // TD
  'toronto-dominion': 'td',
  'toronto dominion': 'td',
  'td canada': 'td',
  // BMO
  'montreal': 'bmo',
  'bmo of montreal': 'bmo',
  'of montreal': 'bmo',
  // Scotiabank
  'scotia': 'scotiabank',
  'nova scotia': 'scotiabank',
  'of nova scotia': 'scotiabank',
  'bns': 'scotiabank',
  // CIBC
  'canadian imperial of commerce': 'cibc',
  'canadian imperial commerce': 'cibc',
  // National Bank
  'national of canada': 'national',
  'nbc': 'national',
  'banque nationale': 'national',
  // Desjardins
  'caisse': 'desjardins',
  'caisse populaire': 'desjardins',
  'caisse desjardins': 'desjardins',
  // UNI (kept explicit so it can never be reached by a partial match)
  'uni cooperation': 'uni',
  'uni financiere': 'uni',
  // Others
  'atb': 'atb',
  'alberta treasury branches': 'atb',
  'coast capital': 'coast capital',
  'steinbach': 'scu',
  'connect first': 'connectfirst',
}

/**
 * Normalize a free-text bank name for lookup.
 * lowercase, strip 'the ', strip 'canada trust'|'bank'|'of canada', collapse whitespace.
 * Invisible characters are removed first: a BOM inside a bank name would defeat
 * every comparison below while looking completely normal on screen.
 */
export function normalizeBankName(raw: string): string {
  return stripInvisible(raw.normalize('NFC'))
    .toLowerCase()
    .replace(/\bthe\b/g, '')
    .replace(/\bcanada trust\b/g, '')
    .replace(/\bbank of canada\b/g, '')
    .replace(/\bbank\b/g, '')
    .replace(/\bcredit union\b/g, '')
    .replace(/\bfinancial\b/g, '')
    .replace(/\bsavings\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Result of a bank lookup. `null` means unmapped — caller MUST hard-fail invoice
 * generation. Exact match only (see BANK_ALIASES for the reasoning).
 */
export function lookupBank(rawName: string, seed: BankLookup[] = BANK_SEED): BankLookup | null {
  if (typeof rawName !== 'string') return null
  const norm = normalizeBankName(rawName)
  if (!norm) return null

  const direct = seed.find(b => norm === b.normalized)
  if (direct) return direct

  const aliasTarget = BANK_ALIASES[norm]
  if (aliasTarget) {
    return seed.find(b => b.normalized === aliasTarget) ?? null
  }

  return null
}
