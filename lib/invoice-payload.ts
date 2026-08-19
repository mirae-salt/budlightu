/**
 * generateInvoicePayload — resolves the 19 tokens from the real invoice template
 * (ARCHITECTURE.md §A.5) into a JSON blob that renderInvoicePdf consumes.
 *
 * PURE. No DB access. Caller (edge function) fetches the inputs and passes them in.
 *
 * Invoice engine implementation: Mirae Lee, mirae.lee@ilovesalt.com.
 */

import { validateInstitution, validateTransit, validateAccount } from './validation'
import { formatInvoiceNumber } from './invoice-numbering'
// ONE rounding helper. This file used to carry a private `round2` identical to
// lib/money.ts's; lib/invoice-lines.ts recomputes the same totals when an admin
// edits a line, and two copies of a money helper is how the two drift apart.
import { round2 } from './money'

export type BamSnapshot = {
  firstName: string
  lastName: string
  street: string
  city: string
  prov: string
  postal: string
  email: string
  phone: string
  bankName: string
  institutionNo: string   // decrypted plaintext
  transitNo: string
  accountNo: string
  hstNumber?: string | null
  initialsResolved: string
}

export type CohortSnapshot = {
  programLabel: string           // e.g. "BUD LIGHT U – BRAND ACTIVATION MANAGER PAYMENT"
  poNumber: string               // e.g. "260351" — must be set before send
  salaryDefault: number          // 218.75 or 250
  currency: 'CAD'
}

export type LedgerSnapshot = {
  paidCad: number                // reimbursement amount (may be 0 → line dropped)
}

export type InvoicePayload = {
  invoiceNumber: string
  invoiceDate: string            // ISO date
  period: string                 // ISO first-of-month
  toBlock: {
    company: 'Salt Experiential Commerce Inc.'
    address: '5th Floor - 99 Atlantic Avenue, Toronto, Ontario, M6K 3J8'
    attn: ['Robin Graham (robin.graham@ilovesalt.com)', 'Nathan Brown (nb@ilovesalt.com)']
  }
  influencer: {
    name: string
    street: string
    cityProvPostal: string
    email: string
    phone: string
  }
  commentsLabel: string
  jobNumber: string
  lines: Array<{
    qty: number
    description: string
    unitPrice: number
    total: number
  }>
  subtotal: number
  tax: number
  total: number
  makeChecksTo: string
  contact: string
  directDeposit: {
    bank: string
    institutionNumber: string    // 3 chars, leading zero preserved
    transitNumber: string        // 5 chars
    accountNumber: string
    email: string
  }
  footer: {
    programTitle: 'BUD LIGHT CAMPUS INVOICE'
    invoiceNumber: string
    dateReadable: string         // "SEPTEMBER 16TH, 2026"
  }
  currency: 'CAD'
}

export function generateInvoicePayload(input: {
  bam: BamSnapshot
  cohort: CohortSnapshot
  ledger: LedgerSnapshot
  period: Date                   // first of month
  seq: number
  revision?: number              // >1 after a void+reissue → "INV-LG3-R2" (P1-22)
  generatedAt: Date
}): InvoicePayload {
  const { bam, cohort, ledger, period, seq, generatedAt } = input
  const revision = input.revision ?? 1

  // HARD FAIL validation — better to block invoice than misroute money
  validateInstitution(bam.institutionNo)
  validateTransit(bam.transitNo)
  validateAccount(bam.accountNo)
  if (!cohort.poNumber) {
    throw new Error('HARD BLOCK: cohort.poNumber not set — invoice cannot be generated')
  }

  // The mailing address was NOT checked, while banking was, even though both come
  // from the same onboarding form. A BAM with banking but no address produced an
  // invoice whose INFLUENCER MAILING ADDRESS block read:
  //     Mirae Lee
  //     , ,
  //     mirae.lee@ilovesalt.com
  // and that document went to AP looking broken. Robin asked for the address on
  // 2026-07-15, so it is required. Blocking is the same fail-closed choice already
  // made for banking, and a BAM who has banking but no address is an anomaly worth
  // stopping on rather than papering over.
  const missingAddress = (['street', 'city', 'prov', 'postal'] as const)
    .filter(f => !String(bam[f] ?? '').trim())
  if (missingAddress.length > 0) {
    throw new Error(
      `HARD BLOCK: mailing address incomplete (missing ${missingAddress.join(', ')}) — ` +
      'invoice NOT created. An invoice with a blank address must not reach AP. ' +
      'Have the BAM complete onboarding, or fill it in on the roster.'
    )
  }

  const invoiceNumber = formatInvoiceNumber(bam.initialsResolved, seq, revision)
  const monthLong = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })

  const salaryLine = {
    qty: 1,
    description: `Brand Activation Manager monthly payment (${monthLong} Payment)`,
    unitPrice: cohort.salaryDefault,
    total: cohort.salaryDefault
  }

  const lines: InvoicePayload['lines'] = [salaryLine]

  if (ledger.paidCad > 0) {
    lines.push({
      qty: 1,
      description: `Reimbursement for sponsorship allowance (${monthLong})`,
      unitPrice: ledger.paidCad,
      total: ledger.paidCad
    })
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.total, 0))
  // TODO (Robin/AP, open question from AUDIT-2026-08-07 P1-10): tax is applied to
  // the whole subtotal, which includes the reimbursement line. The reimbursement
  // is itself a pass-through of receipts that already include HST, so this may be
  // taxing tax. Left AS-IS deliberately — changing what is taxable is a finance
  // decision, not a code decision. Only the NS rate (15% → 14%) was corrected.
  const tax = bam.hstNumber ? computeHst(subtotal, bam.prov) : 0
  const total = round2(subtotal + tax)

  const dateReadable = generatedAt.toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  }).replace(/(\d+),/, ordinal).toUpperCase()

  return {
    invoiceNumber,
    invoiceDate: generatedAt.toISOString(),
    period: period.toISOString().slice(0, 10),
    toBlock: {
      company: 'Salt Experiential Commerce Inc.',
      address: '5th Floor - 99 Atlantic Avenue, Toronto, Ontario, M6K 3J8',
      attn: [
        'Robin Graham (robin.graham@ilovesalt.com)',
        'Nathan Brown (nb@ilovesalt.com)'
      ]
    },
    influencer: {
      name: `${bam.firstName} ${bam.lastName}`,
      street: bam.street,
      cityProvPostal: `${bam.city}, ${bam.prov}, ${bam.postal}`,
      email: bam.email,
      phone: bam.phone
    },
    commentsLabel: cohort.programLabel,
    jobNumber: cohort.poNumber,
    lines,
    subtotal,
    tax,
    total,
    makeChecksTo: `${bam.firstName} ${bam.lastName}`,
    contact: `${bam.firstName} ${bam.lastName}, ${bam.phone}, ${bam.email}`,
    directDeposit: {
      bank: bam.bankName,
      institutionNumber: bam.institutionNo,
      transitNumber: bam.transitNo,
      accountNumber: bam.accountNo,
      email: bam.email
    },
    footer: {
      programTitle: 'BUD LIGHT CAMPUS INVOICE',
      invoiceNumber,
      dateReadable
    },
    currency: 'CAD'
  }
}

const PROVINCE_TAX_RATE: Record<string, number> = {
  ON: 0.13,  // HST
  NB: 0.15,  // HST
  NL: 0.15,  // HST
  NS: 0.14,  // HST — 14% since 2025-04-01 (was 15%). Halifax is a pilot region.
  PE: 0.15,  // HST
  AB: 0.05,  // GST only
  BC: 0.05,  // GST only (PST collected separately by province)
  SK: 0.05,  // GST only
  MB: 0.05,  // GST only
  QC: 0.05,  // GST only (QST collected separately)
  YT: 0.05,  // GST only
  NT: 0.05,  // GST only
  NU: 0.05,  // GST only
}

/**
 * The province codes computeHst accepts, derived from the rate table rather than
 * retyped. The roster editor renders this as a <select>, so a code that would make
 * computeHst throw during the monthly invoice run cannot be entered in the first
 * place. Sorted so the list is stable rather than dependent on key order.
 */
export const PROVINCE_CODES: readonly string[] = Object.keys(PROVINCE_TAX_RATE).sort()

/**
 * The rate computeHst will use, or null when the province code is unknown.
 *
 * Exported so the admin line editor can show a live tax preview with the SAME
 * rate the server will apply, instead of dividing a stored tax by a stored
 * subtotal to guess it. The server still recomputes; this is display only.
 */
export function provinceTaxRate(province?: string | null): number | null {
  const key = (province ?? 'ON').toUpperCase().trim()
  const rate = PROVINCE_TAX_RATE[key]
  return rate == null ? null : rate
}

export function computeHst(subtotal: number, province?: string): number {
  const rate = provinceTaxRate(province)
  if (rate == null) {
    const key = (province ?? 'ON').toUpperCase().trim()
    throw new Error(`Unknown province code "${key}" — cannot compute tax. Fix BAM province before invoicing.`)
  }
  return round2(subtotal * rate)
}

function ordinal(_m: string, day: string): string {
  const d = parseInt(day, 10)
  const suffix =
    (d >= 11 && d <= 13) ? 'TH' :
    d % 10 === 1 ? 'ST' :
    d % 10 === 2 ? 'ND' :
    d % 10 === 3 ? 'RD' : 'TH'
  return `${day}${suffix},`
}
