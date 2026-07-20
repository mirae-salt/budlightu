import { describe, it, expect } from 'vitest'
import {
  formatInvoiceNumber, invoiceDisplayName, apEmailSubject, apEmailBody, invoicePdfFilename
} from '../lib/invoice-numbering'

describe('formatInvoiceNumber', () => {
  it('produces INV-LGR3 for Lucas Grabowski seq 3', () => {
    expect(formatInvoiceNumber('LGR', 3)).toBe('INV-LGR3')
  })
  it('accepts 2-10 uppercase letters', () => {
    expect(formatInvoiceNumber('RG', 1)).toBe('INV-RG1')
    expect(formatInvoiceNumber('LUGR', 12)).toBe('INV-LUGR12')
  })
  it('rejects lowercase or numeric initials', () => {
    expect(() => formatInvoiceNumber('lg', 3)).toThrow()
    expect(() => formatInvoiceNumber('L1', 3)).toThrow()
  })
  it('rejects zero or negative seq', () => {
    expect(() => formatInvoiceNumber('RG', 0)).toThrow()
    expect(() => formatInvoiceNumber('RG', -1)).toThrow()
  })
})

describe('invoiceDisplayName', () => {
  it('formats "First Last - Month Year - Invoice #INV-XXn"', () => {
    const d = new Date(Date.UTC(2026, 6, 1)) // July 2026 (UTC-safe)
    expect(invoiceDisplayName('Robin', 'Graham', d, 'INV-RG1'))
      .toBe('Robin Graham - July 2026 - Invoice #INV-RG1')
  })
})

describe('apEmailSubject', () => {
  it('matches §A.6 spec', () => {
    const d = new Date(Date.UTC(2026, 8, 1))
    expect(apEmailSubject('Lucas', 'Grabowski', d, 'INV-LGR3'))
      .toBe('Lucas Grabowski September Invoice #INV-LGR3')
  })
})

describe('apEmailBody', () => {
  it('contains PROGRAM_LABEL and PO_NUMBER, net15, direct deposit', () => {
    const body = apEmailBody('September', 'BL Campus', '250437')
    expect(body).toContain('BL Campus')
    expect(body).toContain('PO# 250437')
    expect(body).toContain('net15')
    expect(body).toContain('direct deposit')
    expect(body).toContain('September')
  })
})

describe('invoicePdfFilename', () => {
  it('ends in .pdf', () => {
    const d = new Date(Date.UTC(2026, 8, 1))
    expect(invoicePdfFilename('Lucas', 'Grabowski', d, 'INV-LGR3'))
      .toBe('Lucas Grabowski - September 2026 - Invoice #INV-LGR3.pdf')
  })
})
