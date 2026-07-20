/**
 * Canadian bank institution number lookup.
 * All values are strings — leading zeros are load-bearing.
 * Seed data mirrored in supabase/migrations/0005_seed_banks.sql.
 */

export type BankLookup = { normalized: string; institutionNo: string; displayName: string }

export const BANK_SEED: BankLookup[] = [
  { normalized: 'rbc',              institutionNo: '003', displayName: 'RBC Royal Bank' },
  { normalized: 'td',               institutionNo: '004', displayName: 'TD Canada Trust' },
  { normalized: 'bmo',              institutionNo: '001', displayName: 'BMO Bank of Montreal' },
  { normalized: 'scotiabank',       institutionNo: '002', displayName: 'Scotiabank' },
  { normalized: 'cibc',             institutionNo: '010', displayName: 'CIBC' },
  { normalized: 'national',         institutionNo: '006', displayName: 'National Bank of Canada' },
  { normalized: 'hsbc',             institutionNo: '016', displayName: 'HSBC Canada' },
  { normalized: 'desjardins',       institutionNo: '815', displayName: 'Desjardins' },
  { normalized: 'tangerine',        institutionNo: '614', displayName: 'Tangerine' },
  { normalized: 'simplii',          institutionNo: '010', displayName: 'Simplii Financial' },
  { normalized: 'eq',               institutionNo: '623', displayName: 'EQ Bank' },
  { normalized: 'equitable',        institutionNo: '623', displayName: 'Equitable Bank' },
  { normalized: 'atb',              institutionNo: '219', displayName: 'ATB Financial' },
  { normalized: 'laurentian',       institutionNo: '039', displayName: 'Laurentian Bank' },
  { normalized: 'manulife',         institutionNo: '540', displayName: 'Manulife Bank' },
  { normalized: 'canadian western', institutionNo: '030', displayName: 'Canadian Western Bank' },
  { normalized: 'coast capital',    institutionNo: '809', displayName: 'Coast Capital Savings' },
  { normalized: 'vancity',          institutionNo: '809', displayName: 'Vancity' }
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
