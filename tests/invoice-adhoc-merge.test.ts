/**
 * A line a person added must survive the invoice being rebuilt.
 *
 * Two writers touch the same `payload_json`. The line editor puts an admin's ad-hoc
 * line in it; upsertDraftInvoice rebuilds that field WHOLE every time a receipt lands.
 * Before this, Thomas Ambrosio's real invoice carried "BLU Onboarding (Hotel Parking)
 * $60" and his next upload would have deleted it, with nothing on screen to say so.
 *
 * Janet asked to add rows for students who have not submitted a receipt yet. That only
 * works if the row is still there once the receipt arrives, which is what these cover.
 */
import { describe, it, expect } from 'vitest'
import { generateInvoicePayload, type InvoicePayload } from '../lib/invoice-payload'
import { adHocLines, isSystemLine, isSalaryLine, isReimbursementLine } from '../lib/invoice-lines'

const bam = {
  firstName: 'Thomas', lastName: 'Ambrosio',
  street: '1 Main St', city: 'Toronto', prov: 'ON', postal: 'M5V1A1',
  email: 't@example.com', phone: '', bankName: 'TD Canada Trust',
  institutionNo: '004', transitNo: '12345', accountNo: '1234567',
  hstNumber: null, initialsResolved: 'TA'
}
const cohort = { programLabel: 'BLU', poNumber: '260351', salaryDefault: 218.75, currency: 'CAD' as const }
const build = (paidCad: number, extraLines?: InvoicePayload['lines']) =>
  generateInvoicePayload({
    bam, cohort,
    ledger: { paidCad },
    period: new Date('2026-09-01T00:00:00Z'),
    seq: 1,
    generatedAt: new Date('2026-09-04T00:00:00Z'),
    extraLines
  })

const HOTEL = { qty: 1, description: 'BLU Onboarding (Hotel Parking)', unitPrice: 60, total: 60 }

describe('telling the generator lines from a person lines', () => {
  it('recognises the two lines the generator owns', () => {
    const lines = build(50).lines
    expect(lines.every(isSystemLine)).toBe(true)
    expect(lines.filter(isSalaryLine)).toHaveLength(1)
    expect(lines.filter(isReimbursementLine)).toHaveLength(1)
  })

  it('treats anything else as a person line', () => {
    expect(isSystemLine(HOTEL)).toBe(false)
    expect(adHocLines([...build(50).lines, HOTEL])).toEqual([HOTEL])
  })

  it('keeps an unrecognised line rather than dropping it', () => {
    // Erring towards "system" deletes somebody's work. Erring towards "ad-hoc"
    // duplicates a line, which is visible and fixable.
    const odd = { qty: 1, description: 'Something nobody anticipated', unitPrice: 5, total: 5 }
    expect(adHocLines([odd])).toEqual([odd])
  })
})

describe('the rebuild', () => {
  it('keeps the hotel parking when a receipt arrives', () => {
    // Robin adds the line while he has no receipts, then he uploads one.
    const before = build(0, [HOTEL])
    expect(before.lines).toHaveLength(2)

    const after = build(16.95, adHocLines(before.lines))
    expect(after.lines.map(l => l.description)).toContain('BLU Onboarding (Hotel Parking)')
    expect(after.lines.filter(isReimbursementLine)).toHaveLength(1)
  })

  it('does not duplicate it over repeated rebuilds', () => {
    let payload = build(0, [HOTEL])
    for (let i = 0; i < 5; i++) payload = build(16.95, adHocLines(payload.lines))
    expect(payload.lines.filter(l => l.description === HOTEL.description)).toHaveLength(1)
    expect(payload.lines.filter(isSalaryLine)).toHaveLength(1)
  })

  it('counts the added line in the invoice total', () => {
    /*
     * The whole point of passing them into the generator instead of appending
     * afterwards. An invoice whose lines do not add up to its own total is a document
     * AP will bounce.
     */
    const p = build(16.95, [HOTEL])
    const sum = p.lines.reduce((s, l) => s + l.total, 0)
    expect(p.subtotal).toBeCloseTo(sum, 2)
    expect(p.subtotal).toBeCloseTo(218.75 + 16.95 + 60, 2)
    expect(p.total).toBeCloseTo(p.subtotal + p.tax, 2)
  })

  it('puts the person lines after the generator lines', () => {
    const d = build(16.95, [HOTEL]).lines.map(l => l.description)
    expect(d[0]).toMatch(/monthly payment/i)
    expect(d[1]).toMatch(/reimbursement/i)
    expect(d[2]).toBe(HOTEL.description)
  })

  it('holds several added lines, in the order they were put in', () => {
    const uber = { qty: 1, description: 'Uber to campus event', unitPrice: 24.5, total: 24.5 }
    const p = build(0, [HOTEL, uber])
    expect(adHocLines(p.lines)).toEqual([HOTEL, uber])
  })

  it('works when there is no reimbursement line at all', () => {
    // The receipt-less case Janet described: salary plus the added row, nothing else.
    const p = build(0, [HOTEL])
    expect(p.lines.filter(isReimbursementLine)).toHaveLength(0)
    expect(p.subtotal).toBeCloseTo(278.75, 2)
  })
})
