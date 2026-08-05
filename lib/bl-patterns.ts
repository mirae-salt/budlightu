/**
 * Bud Light product recognition patterns — learned from ~400 historical Canadian retail receipts.
 * Used by OCR prompt and fraud detection to distinguish real BL items from false positives.
 *
 * Coverage: LCBO, Beer Store, NSLC, BCL, Liquor Depot, ACE, Boss, Cap, Great Canadian,
 * Real Canadian Liquorstore, Couche-Tard, UBC Liquor, Uber Eats, Costco, Metro, Super C,
 * Safeway, Sobeys, Wine and Beyond, Calgary Co-op, Sherwood Co-op, Liquor House,
 * Urban Cellars, Crowfoot Wine & Spirits, Athena Liquor, Angry Otter, Campus One Stop,
 * Erieau Marina, Green's Superette, Proxi, bars/restaurants, convenience.
 */

// ── Primary text patterns (case-insensitive match against receipt line desc) ──

export const BL_NAME_PATTERNS: RegExp[] = [
  // Core: "BUD LIGHT" or "BUDLIGHT" (no space) in any case, with optional variant suffix
  /\bbud\s*light\b/i,
  /\bbudlight\b/i,

  // Abbreviation: "BUD LT" (Couche-Tard QC, Beer Store)
  /\bbud\s*lt\b/i,

  // Abbreviation: "BUD LIME", "BUD D LIME", "BUD DBL LIME" (Calgary Co-op, Real Canadian)
  /\bbud\s+(?:d\s+|dbl\s+)?lime\b/i,

  // Thermal print artifacts: "BUD LIOT", "BUD L1AT", "BJD LIGHT" (LCBO thermal printers)
  /\bbud\s*l[i1][o0]t\b/i,
  /\bbud\s*l[i1][a4]t\b/i,
  /\bbjd\s*light\b/i,

  // Short code: "BL" followed by flavor/size info (e.g., "BL TALL CAN 6X", "BL STRAWBERRY LEMON")
  /\bbl\s+(?:tall|lime|selt|chel|doub|apple|straw|lager|plat|beer)/i,
  /\bbl\s+\d+(?:x|\s*pk|uc|ml|can|bt|lc|tc|sb|jc|pc)/i,

  // Manufacturer prefix: "LABATT - BUD LIGHT" (BCL BC), "LABATT BUD LIGHT" (BCL)
  /\blabatt\b.*\bbud\b/i,

  // "BUD CHELADA" / "BUD SPICY CHELADA" without "LIGHT"
  /\bbud\s+(?:spicy\s+)?chelada\b/i,

  // French grocery POS abbreviations: "BUDLIG.BIERE", "BUDLISELT.EAU P.", "BUD LIGHT BIERE"
  /\bbudlig\b/i,
  /\bbudliselt\b/i,

  // Bar/restaurant: "DFT Bud Light" (draft), "Can Bud Light", "BUCK BL"
  /\bdft\s+bud\s*light\b/i,
  /\bcan\s+bud\s*light\b/i,
  /\bbuck\s+bl\b/i,

  // Parenthesized: "(BUD LIGHT LIME)****-795022" (Liquor House Edmonton)
  /\(bud\s*light[^)]*\)/i,
]

// ── Known BL variant names (for exact matching after fuzzy match) ──

export const BL_VARIANT_NAMES = [
  'BUD LIGHT',
  'BUD LIGHT LIME',
  'BUD LIGHT LIME TIME',
  'BUD LIGHT LIME TIME MIXER',
  'BUD LIGHT LEMON LIME',
  'BUD LIGHT APPLE',
  'BUD LIGHT CHELADA',
  'BUD LIGHT SPICY CHELADA',
  'BUD LIGHT DOUBLE LIME',
  'BUD LIGHT DBL LIME',
  'BUD LIGHT GOLD',
  'BUD LIGHT SELTZER',
  'BUD LIGHT SELTZER BLACK CHERRY',
  'BUD LIGHT SELTZER MANGO',
  'BUD LIGHT SELTZER MIX PACK',
  'BUD LIGHT SELTZER HARD SODA',
  'BUD LIGHT SELTZER HARD SODA FLAVOUR PAC',
  'BUD LIGHT SELTZER PASSION FRUIT',
  'BUD LIGHT SELTZER STRAWBERRY',
  'BUD LIGHT STRAWBERRY LEMONADE',
  'BUD LIGHT LAGER',
  'BUD LIGHT PLATINUM',
  'BUD LIGHT BEER',
  'BUD LIGHT BIERE',
  'BUD LIGHT JAYS INCASE',
  'BUD LIGHT LIGHT BEER',
  'BUD CHELADA',
  'BUD SPICY CHELADA',
  'BUD LIME',
  'BUD D LIME',
  'BUD DBL LIME',
  'BL STRAWBERRY LEMON',
  'BL SELTZER MIX',
  'BUDLIG.BIERE CAN',
  'BUDLISELT.EAU P.',
  'BUDLIG.PR.PARTN.',
] as const

// ── Size/pack suffixes seen on real receipts ──

export const BL_SIZE_PATTERNS = [
  '15UC', '24UC', '30UC', '48UC', '60UC', '6UC',   // Beer Store unit count
  '1TC', '4TC', '6TC', '12TC', '24TC',              // Beer Store tall can
  '6SB', '24SB', '15SB', '341ML 15SB BT',           // Beer Store standard bottle
  '24JC',                                            // Beer Store JC code
  '6 PK TC', '6 PK-C', '6 PK-B', '15 PK-C',        // LCBO pack codes
  '6 P~C',       // LCBO thermal artifact
  '12-C',        // LCBO hyphenated
  '24 PK-B.',    // LCBO 24-pack bottles
  '6X355', '6X355C', '6X473', '12X355', '12X473',   // pack×size
  '15X355', '30X355', '36X355',
  '355ML 6PK CAN', '355ML 8PK CAN', '355ML 12PK CAN',
  '355ML 15PK CAN', '355ML 24PK CAN', '355ML 30UC CA',
  '473ML 6TC CAN', '473ML 12TC CAN', '473ML 473C CA',
  '8CAN 8AR',   // UBC Liquor
  '740ML',       // Great Canadian single / Ace Liquor 740mL can
  '125B BT', '265B B', // Beer Store bottle codes
  '6LC CAN',     // Beer Store
  '6PC', '12PC', '15PC', '24PC',  // Urban Cellars / Lightspeed POS
  '24PK CA',     // Co-op format
  '15pk', '30pk', // Marina/plain-text format
  '24 PK', '15 PK', '12 PK', '8 PK',  // Alberta stores
  'DOD',         // Draught On Demand (venues)
  '48',          // Costco 48-pack
  '24CAN', '12 CAN', '12 CANS', '24 CAN', // Alberta stores
  '12 C',        // NB Liquor
  '300355',      // LCBO bulk code
  '20x355',      // Proxi / gas station
  '25oz',        // US convenience store (imperial)
  '16oz',        // Bar/restaurant draft
] as const

// ── LCBO product codes → known BL products ──

export const LCBO_BL_PRODUCT_CODES: Record<string, string> = {
  '0001107': 'BUD LIGHT 473mL can',
  '00001107': 'BUD LIGHT 473mL can',
  '00311779': 'BUD LIGHT 6 PK TC (6×473mL)',
  '0031779': 'BUD LIGHT 6 PK TC (6×473mL)',
  '00180810': 'BUD LIGHT LIME 473mL can',
  '0180810': 'BUD LIGHT LIME 473mL can',
  '00218107': 'BUD LIGHT 12×473mL',
  '00676684': 'BUD LIGHT 30×355mL',
  '676684': 'BUD LIGHT 30×355mL',
  '908665': 'BUD LIGHT (LCBO online)',
  '0098665': 'BUD LIGHT 6-pack (LCBO)',
  '0031381': 'BUD LIGHT SELTZER variety pack',
}

// ── Known Canadian liquor store chains ──

export const KNOWN_LIQUOR_STORES = [
  // Provincial monopoly / crown corporation
  'LCBO',
  'BEER STORE',
  'THE BEER STORE',
  'NSLC',
  'BCL',
  'BC LIQUOR',
  'ALCOOL NB LIQUOR',
  'NB LIQUOR',
  'SAQ',
  // Alberta private liquor stores
  'LIQUOR DEPOT',
  'ACE LIQUOR',
  'BOSS LIQUOR',
  'CAP LIQUOR',
  'GREAT CANADIAN LIQUOR',
  'REAL CANADIAN LIQUORSTORE',
  'LIQUOR HOUSE',
  'CROWFOOT WINE',
  'CROWFOOT LIQUOR',
  'ATHENA LIQUOR',
  'ANGRY OTTER',
  // Western Canada chains
  'UBC LIQUOR',
  'WINE RACK',
  'WINE AND BEYOND',
  'SAFEWAY',
  'SAFEWAY LIQUOR',
  'SOBEYS',
  'SOBEYS LIQUOR',
  // Co-ops
  'COSTCO',
  'CALGARY CO-OP',
  'SHERWOOD CO-OP',
  'LAKE COUNTRY CO-OP',
  'CO-OP LIQUOR',
  // Quebec / convenience
  'COUCHE-TARD',
  'DEPANNEUR',
  'SUPER C',
  'METRO',
  'MAXI',
  'PROXI',
  // Ontario grocery / agency
  'LOBLAWS',
  'SUPERSTORE',
  'CAMPUS ONE STOP',
  'ENVERS COUNTRY STORE',
  'ERIEAU MARINA',
  // Urban independents
  'URBAN CELLARS',
] as const

// ── Price ranges by pack size (CAD, before tax/deposit) ──

export const BL_PRICE_RANGES: Record<string, { min: number; max: number }> = {
  'single_can':   { min: 2.50, max: 5.00 },
  '6_pack':       { min: 11.00, max: 20.00 },
  '8_pack':       { min: 13.00, max: 22.00 },
  '12_pack':      { min: 22.00, max: 38.00 },
  '15_pack':      { min: 30.00, max: 42.00 },
  '24_pack':      { min: 40.00, max: 56.00 },
  '28_pack':      { min: 40.00, max: 52.00 },
  '30_pack':      { min: 45.00, max: 62.00 },
  '36_pack':      { min: 55.00, max: 70.00 },
  '60_pack':      { min: 100.00, max: 125.00 },
  'bar_single':   { min: 5.00, max: 15.00 },
}

// ── Tax rates by province ──

export const PROVINCIAL_TAX: Record<string, { type: string; rate: number }> = {
  'ON': { type: 'HST', rate: 0.13 },
  'NS': { type: 'HST', rate: 0.15 },
  'NB': { type: 'HST', rate: 0.15 },
  'NL': { type: 'HST', rate: 0.15 },
  'PE': { type: 'HST', rate: 0.15 },
  'AB': { type: 'GST', rate: 0.05 },
  'BC': { type: 'GST+PST', rate: 0.05 }, // PST Liquor 10% additional
  'SK': { type: 'GST+PST', rate: 0.11 },
  'MB': { type: 'GST+PST', rate: 0.12 },
  'QC': { type: 'GST+QST', rate: 0.14975 },
}

// ── Non-receipt detection keywords ──

export const NON_RECEIPT_KEYWORDS = [
  'criminal record',
  'judicial matters',
  'police check',
  'vulnerable sector',
  'bus ticket',
  'busbud',
  'rider express',
  'greyhound',
  'uber ride',
  'uberxl',
  'trip fare',
  'booking fee',
  'interac.*notification',
  'scotiabank.*debit',
  'td.*alert',
  'bmo.*alert',
  'marshalls',
  'domino.*pizza',
  'pepperoni',
  'chase center',
  'golden state warriors',
  'marathon petro',
] as const

// ── Helper: check if text matches any BL pattern ──

export function isBudLightText(text: string): { match: boolean; pattern?: string } {
  const t = text.trim()
  for (const re of BL_NAME_PATTERNS) {
    if (re.test(t)) {
      return { match: true, pattern: re.source }
    }
  }
  return { match: false }
}
