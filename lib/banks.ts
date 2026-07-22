/**
 * Canadian bank institution number lookup.
 * All values are strings — leading zeros are load-bearing.
 * Bank list sourced from Interac Sign-In partners (2026).
 * Seed data mirrored in supabase/migrations/0005_seed_banks.sql.
 */

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
 * Normalize a free-text bank name for lookup.
 * lowercase, strip 'the ', strip 'canada trust'|'bank'|'of canada', collapse whitespace.
 */
export function normalizeBankName(raw: string): string {
  return raw
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
 * Result of a bank lookup. `null` means unmapped — caller MUST hard-fail invoice generation.
 */
export function lookupBank(rawName: string, seed: BankLookup[] = BANK_SEED): BankLookup | null {
  const norm = normalizeBankName(rawName)
  return seed.find(b => norm === b.normalized || norm.includes(b.normalized)) ?? null
}
