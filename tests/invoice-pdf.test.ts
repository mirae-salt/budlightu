import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import { generateInvoicePayload } from '../lib/invoice-payload'
import { renderInvoicePdfToBuffer } from '../lib/render-pdf'
import { assertPdfRenderable } from '../lib/pdf-text'

/** Real text extraction: react-pdf writes hex strings inside TJ arrays. */
function pdfText(buf: Buffer): string {
  const s = buf.toString('latin1')
  let decoded = ''
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const st = m.index + m[0].length
    const en = s.indexOf('endstream', st)
    if (en < 0) continue
    try { decoded += zlib.inflateSync(Buffer.from(s.slice(st, en), 'latin1')).toString('latin1') } catch { /* binary */ }
  }
  let text = ''
  for (const seg of decoded.matchAll(/BT([\s\S]*?)ET/g)) {
    for (const h of seg[1].matchAll(/<([0-9A-Fa-f]*)>/g)) text += Buffer.from(h[1], 'hex').toString('latin1')
    text += '\n'
  }
  return text
}

const payload = generateInvoicePayload({
  bam: {
    firstName: 'Lucas', lastName: 'Grabowski',
    street: '12 King St', city: 'Toronto', prov: 'ON', postal: 'M6K 1Z5',
    email: 'lucas@example.com', phone: '416-555-0100',
    bankName: 'RBC Royal Bank',
    institutionNo: '003', transitNo: '00123', accountNo: '0000456789',
    hstNumber: null, initialsResolved: 'LG'
  },
  cohort: { programLabel: 'BUD LIGHT U', poNumber: '260351', salaryDefault: 218.75, currency: 'CAD' },
  ledger: { paidCad: 112.4 },
  period: new Date('2026-09-01T00:00:00Z'),
  seq: 3,
  generatedAt: new Date('2026-09-16T00:00:00Z')
})

describe('dry-run: payload vs PDF bytes', () => {
  it('payload keeps leading zeros as strings', () => {
    expect(payload.directDeposit).toMatchObject({
      institutionNumber: '003', transitNumber: '00123', accountNumber: '0000456789'
    })
    expect(payload.invoiceNumber).toBe('INV-LG3')
    expect(payload.lines.map(l => l.total)).toEqual([218.75, 112.4])
    expect(payload.subtotal).toBe(331.15)
    expect(payload.total).toBe(331.15)
    expect(payload.jobNumber).toBe('260351')
  })

  it('the rendered PDF prints exactly those bytes', async () => {
    const text = pdfText(await renderInvoicePdfToBuffer(payload))
    expect(text).toMatch(/INSTITUTION NUMBER:\n?003/)
    expect(text).toMatch(/TRANSIT NUMBER:\n?00123/)
    expect(text).toMatch(/ACCOUNT NUMBER:\n?0000456789/)
    for (const needle of ['INV-LG3', '260351', '218.75', '112.40', '331.15', 'SEPTEMBER 16TH, 2026']) {
      expect(text.includes(needle), `PDF must contain ${needle}`).toBe(true)
    }
    // leading zeros not eaten anywhere
    expect(text.includes('\n123')).toBe(false)
    expect(text.includes('\n456789')).toBe(false)
    expect(text.includes('\n3\n')).toBe(false)
  })

  it('an unprintable name is reported precisely by the pre-flight check', () => {
    const bad = { ...payload, influencer: { ...payload.influencer, name: 'Michał Nowak' } }
    expect(() => assertPdfRenderable(bad)).toThrow(/influencer\.name/)
    expect(() => assertPdfRenderable(bad)).toThrow(/U\+0142/)
  })

  it('and the render itself still fails closed rather than printing MichaB', async () => {
    const bad = { ...payload, influencer: { ...payload.influencer, name: 'Michał Nowak' } }
    await expect(renderInvoicePdfToBuffer(bad)).rejects.toThrow()
  })

  it('NFD accents come out as one composed glyph, not E + combining mark', async () => {
    const nfd = { ...payload, influencer: { ...payload.influencer, name: 'E\u0301mile Co\u0302te\u0301' } }
    const text = pdfText(await renderInvoicePdfToBuffer(nfd))
    expect(text.includes('\u0301')).toBe(false)
    // WinAnsi byte for É is 0xC9, for ô 0xF4
    expect(text.includes('\u00c9mile')).toBe(true)
  })
})
