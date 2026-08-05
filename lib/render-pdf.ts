import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePdf } from './pdf-template'
import type { InvoicePayload } from './invoice-payload'
import * as React from 'react'

export async function renderInvoicePdfToBuffer(payload: InvoicePayload): Promise<Buffer> {
  return renderToBuffer(React.createElement(InvoicePdf, { payload }) as any)
}

export function buildSamplePayload(row: {
  number: string
  bam: string
  amount: string
  period: string
}): InvoicePayload {
  const [firstName = 'BAM', ...rest] = row.bam.split(' ')
  const lastName = rest.join(' ') || 'Unknown'
  const total = parseFloat(row.amount.replace(/[$,]/g, '') || '0')
  const salary = 218.75
  const reimbursement = Math.max(0, total - salary)

  const periodDate = parsePeriodString(row.period)
  const monthLong = periodDate.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })

  const lines: InvoicePayload['lines'] = [
    { qty: 1, description: `Brand Activation Manager monthly payment (${monthLong} Payment)`, unitPrice: salary, total: salary }
  ]
  if (reimbursement > 0) {
    lines.push({ qty: 1, description: `Reimbursement for sponsorship allowance (${monthLong})`, unitPrice: reimbursement, total: reimbursement })
  }

  const subtotal = lines.reduce((s, l) => s + l.total, 0)

  return {
    invoiceNumber: row.number,
    invoiceDate: new Date().toISOString(),
    period: periodDate.toISOString().slice(0, 10),
    toBlock: {
      company: 'Salt Experiential Commerce, Inc.',
      address: '249 Dufferin Street Toronto, ON, M6K 1Z5',
      attn: ['Robin Graham (robin.graham@ilovesalt.com)', 'Nathan Brown (nb@ilovesalt.com)']
    },
    influencer: {
      name: `${firstName} ${lastName}`,
      street: '(address on file)',
      cityProvPostal: '(city, prov, postal on file)',
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase().replace(/ /g, '')}@example.com`,
      phone: '(phone on file)'
    },
    commentsLabel: 'BUD LIGHT U – BRAND ACTIVATION MANAGER PAYMENT',
    jobNumber: '260351',
    lines,
    subtotal,
    tax: 0,
    total: subtotal,
    makeChecksTo: `${firstName} ${lastName}`,
    contact: `${firstName} ${lastName}`,
    directDeposit: {
      bank: '(bank on file)',
      institutionNumber: '---',
      transitNumber: '-----',
      accountNumber: '-------',
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase().replace(/ /g, '')}@example.com`
    },
    footer: {
      programTitle: 'BUD LIGHT CAMPUS INVOICE',
      invoiceNumber: row.number,
      dateReadable: new Date().toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).toUpperCase()
    },
    currency: 'CAD'
  }
}

function parsePeriodString(s: string): Date {
  const match = s.match(/(\w+)\s+(\d{4})/)
  if (match) {
    const d = new Date(`${match[1]} 1, ${match[2]}`)
    if (!isNaN(d.getTime())) return d
  }
  const iso = new Date(s)
  if (!isNaN(iso.getTime())) return iso
  return new Date()
}
