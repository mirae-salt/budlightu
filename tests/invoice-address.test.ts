import { describe, it, expect } from 'vitest'
import { generateInvoicePayload } from '../lib/invoice-payload'

const BAM = {
  firstName: 'Mirae', lastName: 'Lee', email: 'x@y.ca',
  street: '12 Main St', city: 'Toronto', prov: 'ON', postal: 'M5V 1A1',
  bankName: 'RBC Royal Bank', institutionNo: '003', transitNo: '00123',
  accountNo: '0000456789', hstNumber: null, initialsResolved: 'ML'
}
const COHORT = { poNumber: '260351', programLabel: 'BL Campus', salaryDefault: 218.75 }
const BASE = {
  bam: BAM, cohort: COHORT, ledger: { paidCad: 0 },
  period: new Date('2026-09-01T00:00:00Z'), seq: 1, generatedAt: new Date('2026-09-16T00:00:00Z')
}

describe('invoice blocks on an incomplete mailing address', () => {
  it('a complete address generates', () => {
    expect(() => generateInvoicePayload(BASE as never)).not.toThrow()
  })

  it.each(['street', 'city', 'prov', 'postal'])('a missing %s blocks, and names the field', (field) => {
    const bam = { ...BAM, [field]: '' }
    expect(() => generateInvoicePayload({ ...BASE, bam } as never)).toThrow(new RegExp(field))
  })

  it('whitespace is not an address', () => {
    const bam = { ...BAM, street: '   ' }
    expect(() => generateInvoicePayload({ ...BASE, bam } as never)).toThrow(/street/)
  })

  it('the message says the invoice was not created', () => {
    const bam = { ...BAM, city: '' }
    expect(() => generateInvoicePayload({ ...BASE, bam } as never)).toThrow(/NOT created/)
  })
})
