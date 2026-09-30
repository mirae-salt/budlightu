/**
 * An invoice may be created without a mailing address. It may not be sent without one.
 *
 * Until 2026-09-30 a missing address refused creation. Lea Major then had an approved
 * September reimbursement and no invoice anyone could see, so the block moved to the send
 * (lib/invoice-address-placeholder). What these guard: the placeholder is what prints, the
 * send gate reads it, and filling the address in clears it.
 */
import { describe, it, expect } from 'vitest'
import { generateInvoicePayload } from '../lib/invoice-payload'
import { addressPendingProblem, STREET_PLACEHOLDER, CITY_LINE_PLACEHOLDER } from '../lib/invoice-address-placeholder'
import { mergeInvoiceSnapshot } from '../lib/refresh-invoice-snapshot'

const BAM = {
  firstName: 'Mirae', lastName: 'Lee', email: 'x@y.ca',
  street: '12 Main St', city: 'Toronto', prov: 'ON', postal: 'M5V 1A1',
  bankName: 'RBC Royal Bank', institutionNo: '003', transitNo: '00123',
  accountNo: '0000456789', hstNumber: null, initialsResolved: 'ML'
}
const COHORT = { poNumber: '260351', programLabel: 'BL Campus', salaryDefault: 218.75 }
const BASE = {
  bam: BAM, cohort: COHORT, ledger: { paidCad: 150 },
  period: new Date('2026-09-01T00:00:00Z'), seq: 1, generatedAt: new Date('2026-09-16T00:00:00Z')
}
const build = (bam: Record<string, unknown>) => generateInvoicePayload({ ...BASE, bam } as never)

describe('a complete address', () => {
  it('prints as given and can be sent', () => {
    const p = build(BAM)
    expect(p.influencer.street).toBe('12 Main St')
    expect(p.influencer.cityProvPostal).toBe('Toronto, ON, M5V 1A1')
    expect(p.addressPending).toBeUndefined()
    expect(addressPendingProblem(p)).toBeNull()
  })
})

describe('a missing address builds a draft that cannot be sent', () => {
  it.each(['street', 'city', 'prov', 'postal'])('a missing %s still creates the invoice, marked', field => {
    const p = build({ ...BAM, [field]: '' })
    expect(p.addressPending).toEqual([field])
    expect(p.influencer.street).toBe(STREET_PLACEHOLDER)
    expect(p.influencer.cityProvPostal).toBe(CITY_LINE_PLACEHOLDER)
  })

  it('whitespace is not an address', () => {
    expect(build({ ...BAM, street: '   ' }).addressPending).toEqual(['street'])
  })

  it('Lea Major: all four blank, the money lines are still right', () => {
    const p = build({ ...BAM, street: null, city: null, prov: null, postal: null })
    expect(p.addressPending).toEqual(['street', 'city', 'prov', 'postal'])
    expect(p.lines.map(l => l.total)).toEqual([218.75, 150])
    expect(p.total).toBe(368.75)
  })

  it('the send gate names what is missing', () => {
    const reason = addressPendingProblem(build({ ...BAM, city: '', postal: '' }))
    expect(reason).toMatch(/^No mailing address on file/)
    expect(reason).toContain('city, postal code')
  })

  it('the send gate still refuses a placeholder that lost its mark', () => {
    const p = build({ ...BAM, street: '' }) as unknown as Record<string, unknown>
    delete p.addressPending
    expect(addressPendingProblem(p)).toMatch(/No mailing address/)
  })

  it('banking still blocks creation outright', () => {
    expect(() => build({ ...BAM, street: '', accountNo: '' })).toThrow()
  })
})

describe('filling the address in on the roster clears the mark', () => {
  const pending = build({ ...BAM, street: '', city: '', prov: '', postal: '' }) as unknown as Record<string, unknown>

  it('all four at once: real address, no mark, sendable', () => {
    const { next, changed } = mergeInvoiceSnapshot(pending, { street: '12 Main St', city: 'Toronto', prov: 'ON', postal: 'M5V 1A1' })
    const n = next as { influencer: { street: string; cityProvPostal: string }; addressPending?: unknown }
    expect(n.influencer.street).toBe('12 Main St')
    expect(n.influencer.cityProvPostal).toBe('Toronto, ON, M5V 1A1')
    expect(n.addressPending).toBeUndefined()
    expect(addressPendingProblem(n)).toBeNull()
    expect(changed).toContain('address no longer missing')
  })

  it('street alone is not enough: the mark stays', () => {
    const { next } = mergeInvoiceSnapshot(pending, { street: '12 Main St', city: '', prov: '', postal: '' })
    expect(addressPendingProblem(next)).toMatch(/No mailing address/)
  })

  it('the placeholder line is never kept as part of the new address', () => {
    const { next } = mergeInvoiceSnapshot(pending, { street: '12 Main St', city: 'Toronto', prov: undefined, postal: 'M5V 1A1' })
    // Province not supplied, so there is no complete city line to write.
    expect((next as { influencer: { cityProvPostal: string } }).influencer.cityProvPostal).toBe(CITY_LINE_PLACEHOLDER)
    expect(addressPendingProblem(next)).not.toBeNull()
  })
})
