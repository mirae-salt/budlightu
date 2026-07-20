/**
 * generateInvoicePayload — resolves the 19 tokens from the real invoice template
 * (ARCHITECTURE.md §A.5) into a JSON blob that renderInvoicePdf consumes.
 *
 * PURE. No DB access. Caller (edge function) fetches the inputs and passes them in.
 */

import { validateInstitution, validateTransit, validateAccount } from './validation'
import { formatInvoiceNumber } from './invoice-numbering'

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
  poNumber: string               // e.g. "250437" — must be set before send
  salaryDefault: number          // 218.75 or 250
  currency: 'CAD'
}

export type LedgerSnapshot = {
  paidUsd: number                // reimbursement amount (may be 0 → line dropped)
}

export type InvoicePayload = {
  invoiceNumber: string
  invoiceDate: string            // ISO date
  period: string                 // ISO first-of-month
  toBlock: {
    company: 'Salt Experiential Commerce, Inc.'
    address: '249 Dufferin Street Toronto, ON, M6K 1Z5'
    attn: ['Jenna Greenspoon (jenna.greenspoon@ilovesalt.com)', 'Nathan Brown (nb@ilovesalt.com)']
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
  generatedAt: Date
}): InvoicePayload {
  const { bam, cohort, ledger, period, seq, generatedAt } = input

  // HARD FAIL validation — better to block invoice than misroute money
  validateInstitution(bam.institutionNo)
  validateTransit(bam.transitNo)
  validateAccount(bam.accountNo)
  if (!cohort.poNumber) {
    throw new Error('HARD BLOCK: cohort.poNumber not set — invoice cannot be generated')
  }

  const invoiceNumber = formatInvoiceNumber(bam.initialsResolved, seq)
  const monthLong = period.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })

  const salaryLine = {
    qty: 1,
    description: `Brand Activation Manager monthly payment (${monthLong} Payment)`,
    unitPrice: cohort.salaryDefault,
    total: cohort.salaryDefault
  }

  const lines: InvoicePayload['lines'] = [salaryLine]

  if (ledger.paidUsd > 0) {
    lines.push({
      qty: 1,
      description: `Reimbursement for sponsorship allowance (${monthLong})`,
      unitPrice: ledger.paidUsd,
      total: ledger.paidUsd
    })
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.total, 0))
  const tax = bam.hstNumber ? computeHst(subtotal) : 0
  const total = round2(subtotal + tax)

  const dateReadable = generatedAt.toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  }).replace(/(\d+),/, ordinal).toUpperCase()

  return {
    invoiceNumber,
    invoiceDate: generatedAt.toISOString(),
    period: period.toISOString().slice(0, 10),
    toBlock: {
      company: 'Salt Experiential Commerce, Inc.',
      address: '249 Dufferin Street Toronto, ON, M6K 1Z5',
      attn: [
        'Jenna Greenspoon (jenna.greenspoon@ilovesalt.com)',
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

/** HST at 13% (Ontario / Atlantic mix — MVP; real rate should look up by province). */
export function computeHst(subtotal: number): number {
  return round2(subtotal * 0.13)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
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
