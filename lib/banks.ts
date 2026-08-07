/**
 * Canadian bank institution number lookup.
 * All values are strings — leading zeros are load-bearing.
 * Seed data mirrored in supabase/migrations/0005_seed_banks.sql (corrected by 0019).
 *
 * ── 2026-08-07 CORRECTION (9 of 22 values were wrong) ────────────────────────
 * The original list was "sourced from Interac Sign-In partners", which is a
 * LOGIN-FEDERATION list, not a payments-routing list. Interac Sign-In membership
 * says nothing about which central a credit union clears through, so seven credit
 * unions were all seeded as 839 and two caisses as 815. Both are live institution
 * numbers, so a payment would have passed every format check and entered the wrong
 * clearing stream carrying a transit that does not exist there.
 *
 * Canada has one central PER REGION, not one central overall:
 *   809 Central 1 (BC) · 828 Central 1 (Ontario) · 839/849 Atlantic Central
 *   879 CU Central Manitoba · 889 CU Central Saskatchewan · 899 CU Central Alberta
 * Some credit unions have their OWN number and the central default is wrong for
 * them: Meridian 837, Alterna Savings 842, Caisse Alliance 890, UNI 865.
 *
 * Every value below was verified against at least two independent sources (the
 * institution's own direct-deposit page plus an independent routing database).
 * NOT verified against the Payments Canada Financial Institutions File, which is
 * subscription-only — so Salt finance/AP must still confirm before the first live
 * run. See .claude/AUDIT-2026-08-07.md.
 *
 * NOTE ON HOW THIS TABLE IS USED: the number that goes on the invoice is the one
 * the BAM copied off their own void cheque / direct-deposit form, NOT this table.
 * This table cross-checks that entry and flags a mismatch to Robin. Do not change
 * it into the source of truth: a name-to-number table drifts every time a credit
 * union merges or federalizes, and this correction is what that drift looks like.
 */

import { stripInvisible } from './sanitize'

export type BankLookup = { normalized: string; institutionNo: string; displayName: string }

export const BANK_SEED: BankLookup[] = [
  // ── Schedule I banks and direct-banking brands (all previously correct) ──
  { normalized: 'bmo',               institutionNo: '001', displayName: 'BMO Bank of Montreal' },
  { normalized: 'scotiabank',        institutionNo: '002', displayName: 'Scotiabank' },
  { normalized: 'rbc',               institutionNo: '003', displayName: 'RBC Royal Bank' },
  { normalized: 'td',                institutionNo: '004', displayName: 'TD Canada Trust' },
  { normalized: 'national',          institutionNo: '006', displayName: 'National Bank of Canada' },
  { normalized: 'cibc',              institutionNo: '010', displayName: 'CIBC' },
  { normalized: 'simplii',           institutionNo: '010', displayName: 'Simplii Financial' }, // CIBC-owned, shares 010
  { normalized: 'laurentian',        institutionNo: '039', displayName: 'Laurentian Bank' },
  { normalized: 'atb',               institutionNo: '219', displayName: 'ATB Financial' },
  { normalized: 'first nations',     institutionNo: '310', displayName: 'First Nations Bank of Canada' },
  { normalized: 'pc financial',      institutionNo: '320', displayName: "President's Choice Financial" },
  { normalized: 'canadian tire',     institutionNo: '338', displayName: 'Canadian Tire Bank' },
  { normalized: 'manulife',          institutionNo: '540', displayName: 'Manulife Bank' },
  { normalized: 'tangerine',         institutionNo: '614', displayName: 'Tangerine' },
  { normalized: 'alterna bank',      institutionNo: '608', displayName: 'Alterna Bank' },
  { normalized: 'peoples trust',     institutionNo: '621', displayName: 'Peoples Trust' }, // backs KOHO
  { normalized: 'eq bank',           institutionNo: '623', displayName: 'EQ Bank (Equitable Bank)' },
  { normalized: 'wealthsimple',      institutionNo: '703', displayName: 'Wealthsimple' },

  // ── Caisses. 815 is Desjardins QUEBEC only; the other two are separate. ──
  { normalized: 'desjardins',        institutionNo: '815', displayName: 'Desjardins' },
  { normalized: 'desjardins ontario', institutionNo: '829', displayName: 'Desjardins Ontario Credit Union' },
  { normalized: 'uni',               institutionNo: '865', displayName: 'UNI Financial Cooperation' },   // was 815
  { normalized: 'caisse alliance',   institutionNo: '890', displayName: 'Caisse Alliance' },             // was 815

  // ── Credit unions. Number is the PROVINCIAL central unless noted. ──
  { normalized: 'vancity',           institutionNo: '809', displayName: 'Vancity' },                     // Central 1 BC
  // Coast Capital is a FEDERAL credit union with its own entity code 382, but its
  // retail deposit accounts still route on 809. Do not "fix" this to 382.
  { normalized: 'coast capital',     institutionNo: '809', displayName: 'Coast Capital Savings' },
  { normalized: 'libro',             institutionNo: '828', displayName: 'Libro Credit Union' },          // was 839, Central 1 ON
  { normalized: 'meridian',          institutionNo: '837', displayName: 'Meridian Credit Union' },       // was 839, own number
  { normalized: 'alterna savings',   institutionNo: '842', displayName: 'Alterna Savings' },             // own number, not 828
  { normalized: 'scu',               institutionNo: '879', displayName: 'SCU (Steinbach Credit Union)' },// was 839, MB central
  { normalized: 'affinity',          institutionNo: '889', displayName: 'Affinity Credit Union' },       // was 839, SK central
  { normalized: 'conexus',           institutionNo: '889', displayName: 'Conexus Credit Union' },        // was 839, SK central
  { normalized: 'connectfirst',      institutionNo: '899', displayName: 'connectFirst Credit Union' },   // was 839, AB central
  { normalized: 'servus',            institutionNo: '899', displayName: 'Servus Credit Union' },         // was 839, AB central
]

/**
 * Institutions deliberately NOT listed, because a dead code routes into a closed
 * clearing lane while an unlisted name hard-fails safely and reaches a human:
 *   HSBC Canada (016)        - acquired by RBC, migrated 2024-03-29. Use RBC 003.
 *   Canadian Western (030)   - acquired by National Bank, closed 2025. Use National 006.
 *   motusbank (374)          - wound down into Meridian. Use Meridian 837.
 */

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
  // Desjardins Quebec (815) ONLY. The other caisses have their own numbers, so
  // a bare "caisse populaire" must NOT fall through to Desjardins: an Acadienne
  // (UNI, 865) or Alliance (890) member would be routed into the wrong stream.
  'caisse': 'desjardins',
  'caisse desjardins': 'desjardins',
  'federation des caisses desjardins': 'desjardins',
  'desjardins ontario': 'desjardins ontario',
  'caisse desjardins ontario': 'desjardins ontario',
  // UNI = former Caisse populaire acadienne (NB), 865. Kept explicit so it can
  // never be reached by a partial match.
  'uni cooperation': 'uni',
  'uni financiere': 'uni',
  'caisse populaire acadienne': 'uni',
  'acadienne': 'uni',
  // Caisse Alliance = Alliance des caisses populaires de l'Ontario, 890.
  'alliance des caisses populaires': 'caisse alliance',
  'caisse populaire alliance': 'caisse alliance',
  // Others
  'atb': 'atb',
  'alberta treasury branches': 'atb',
  'coast capital': 'coast capital',
  'steinbach': 'scu',
  'connect first': 'connectfirst',
  // KOHO is a program on Peoples Trust; the name on the account is Peoples Trust.
  'koho': 'peoples trust',
  'peoples': 'peoples trust',
  // EQ Bank trades as Equitable Bank.
  'eq': 'eq bank',
  'equitable': 'eq bank',
  'presidents choice': 'pc financial',
  'president s choice': 'pc financial',
  'pc': 'pc financial',
  'alterna': 'alterna savings',
  'first nations of canada': 'first nations',
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
