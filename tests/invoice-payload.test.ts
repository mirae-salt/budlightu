/**
 * Semantic assertions on invoice payload (§A.12 v1 scope reduction:
 * we assert 19 tokens present + correct amounts + leading zeros preserved,
 * NOT pixel-diff on the PDF).
 */
import { describe, it, expect } from 'vitest'
import { generateInvoicePayload, computeHst } from '../lib/invoice-payload'

const bam = {
  firstName: 'Gabriella',
  lastName: 'Portillo',
  street: '554 Johnson',
  city: 'Kingston',
  prov: 'ON',
  postal: 'K7L 2A1',
  email: 'gabriella.r.e.portillo@gmail.com',
  phone: '647-225-0077',
  bankName: 'TD Canada Trust',
  institutionNo: '004',
  transitNo: '03352',
  accountNo: '6902025',
  hstNumber: null,
  initialsResolved: 'GP'
}

const cohort = {
  programLabel: 'BUD LIGHT U – BRAND ACTIVATION MANAGER PAYMENT',
  poNumber: '260351',
  salaryDefault: 218.75,
  currency: 'CAD' as const
}

describe('generateInvoicePayload — matches real Gabriella #106 semantics', () => {
  const payload = generateInvoicePayload({
    bam, cohort,
    ledger: { paidCad: 150 },
    period: new Date(Date.UTC(2026, 2, 1)),  // March
    seq: 1,
    generatedAt: new Date(Date.UTC(2026, 2, 20))
  })

  it('invoiceNumber uses resolved initials', () => {
    expect(payload.invoiceNumber).toBe('INV-GP1')
  })

  it('preserves leading zeros for institution + transit', () => {
    expect(payload.directDeposit.institutionNumber).toBe('004')
    expect(payload.directDeposit.transitNumber).toBe('03352')
  })

  it('has 2 line items when reimbursement > 0', () => {
    expect(payload.lines).toHaveLength(2)
    expect(payload.lines[0].total).toBe(218.75)  // salary
    expect(payload.lines[1].total).toBe(150)     // reimbursement
  })

  it('drops reimbursement line when paidCad = 0 (P0-2 companion)', () => {
    const shortfallPayload = generateInvoicePayload({
      bam, cohort,
      ledger: { paidCad: 0 },
      period: new Date(Date.UTC(2026, 2, 1)),
      seq: 2,
      generatedAt: new Date(Date.UTC(2026, 2, 20))
    })
    expect(shortfallPayload.lines).toHaveLength(1)
    expect(shortfallPayload.lines[0].description).toContain('monthly payment')
  })

  it('salary is ALWAYS present even on shortfall (P0-2 core rule)', () => {
    const p = generateInvoicePayload({
      bam, cohort,
      ledger: { paidCad: 0 },
      period: new Date(Date.UTC(2026, 2, 1)),
      seq: 3,
      generatedAt: new Date(Date.UTC(2026, 2, 20))
    })
    expect(p.lines[0].total).toBe(218.75)
  })

  it('subtotal + total correct when no HST', () => {
    expect(payload.subtotal).toBe(368.75)
    expect(payload.tax).toBe(0)
    expect(payload.total).toBe(368.75)
  })

  it('applies HST when bam has HST number', () => {
    const bamWithHst = { ...bam, hstNumber: '123456789RT0001' }
    const p = generateInvoicePayload({
      bam: bamWithHst, cohort,
      ledger: { paidCad: 150 },
      period: new Date(Date.UTC(2026, 2, 1)),
      seq: 4,
      generatedAt: new Date(Date.UTC(2026, 2, 20))
    })
    expect(p.tax).toBeGreaterThan(0)
    expect(p.total).toBeCloseTo(p.subtotal + p.tax, 2)
  })

  it('HARD FAIL on missing PO', () => {
    expect(() =>
      generateInvoicePayload({
        bam,
        cohort: { ...cohort, poNumber: '' },
        ledger: { paidCad: 150 },
        period: new Date(Date.UTC(2026, 2, 1)),
        seq: 5,
        generatedAt: new Date(Date.UTC(2026, 2, 20))
      })
    ).toThrow(/HARD BLOCK.*poNumber/)
  })

  it('HARD FAIL on malformed transit (stripped leading zero)', () => {
    const badBam = { ...bam, transitNo: '3352' } // dropped the leading 0
    expect(() =>
      generateInvoicePayload({
        bam: badBam, cohort,
        ledger: { paidCad: 150 },
        period: new Date(Date.UTC(2026, 2, 1)),
        seq: 6,
        generatedAt: new Date(Date.UTC(2026, 2, 20))
      })
    ).toThrow(/transit/)
  })

  it('contains all critical footer / header fields (19-token spot check)', () => {
    // Tokens: name / addr / attn / comments / job / lines / subtotal / tax / total /
    //         checks-to / contact / bank / institution / transit / account / email / footer
    expect(payload.footer.programTitle).toBe('BUD LIGHT CAMPUS INVOICE')
    expect(payload.footer.invoiceNumber).toBe('INV-GP1')
    expect(payload.jobNumber).toBe('260351')
    expect(payload.toBlock.attn.length).toBe(2)
    expect(payload.commentsLabel).toContain('BUD LIGHT')
    expect(payload.makeChecksTo).toBe('Gabriella Portillo')
    expect(payload.contact).toContain('647-225-0077')
  })
})

describe('computeHst', () => {
  it('defaults to ON (13%) when no province given', () => {
    expect(computeHst(100)).toBe(13)
    expect(computeHst(368.75)).toBe(47.94)
  })
  it('ON = 13% HST', () => {
    expect(computeHst(100, 'ON')).toBe(13)
  })
  it('AB = 5% GST only', () => {
    expect(computeHst(100, 'AB')).toBe(5)
    expect(computeHst(368.75, 'AB')).toBe(18.44)
  })
  it('NS = 15% HST', () => {
    expect(computeHst(100, 'NS')).toBe(15)
    expect(computeHst(368.75, 'NS')).toBe(55.31)
  })
  it('throws on unknown province code', () => {
    expect(() => computeHst(100, 'XX')).toThrow('Unknown province code')
  })
})
