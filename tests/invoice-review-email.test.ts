import { describe, it, expect } from 'vitest'
import { invoiceReleaseEmail, invoiceRevisedEmail } from '../lib/invoice-review-email'

const base = {
  firstName: 'Elle',
  month: 'September 2026',
  invoiceNumber: 'INV-EE1',
  deadline: 'Thursday, September 17 at 1:00 p.m. Eastern',
  portalUrl: 'https://budlightu.com/portal/invoices',
  total: 363.3,
  attached: true
}

describe('the review emails a BAM actually receives', () => {
  it('the release email names the figure, the deadline and what silence means', () => {
    const m = invoiceReleaseEmail(base)
    expect(m.subject).toBe('Please check your September 2026 invoice')
    expect(m.html).toContain('$363.30')
    expect(m.html).toContain('Thursday, September 17 at 1:00 p.m. Eastern')
    expect(m.text).toContain('we send it to accounts payable as it stands')
  })

  it('says "ready" rather than "attached" when nothing is attached', () => {
    expect(invoiceReleaseEmail({ ...base, attached: false }).text).toContain('is ready on your portal')
    expect(invoiceReleaseEmail(base).text).toContain('is attached')
  })

  it('the revision email states both figures and that the deadline held', () => {
    const m = invoiceRevisedEmail({ ...base, total: 403.3, previousTotal: 363.3 })
    expect(m.subject).toBe('Your September 2026 invoice has changed')
    expect(m.text).toContain('The total went from $363.30 to $403.30.')
    expect(m.html).toContain('The deadline has not changed')
  })

  it('a missing figure degrades to a sentence rather than printing $null', () => {
    const m = invoiceRevisedEmail({ ...base, total: null, previousTotal: null })
    expect(m.text).toContain('The amount changed.')
    expect(m.text).not.toContain('null')
    expect(invoiceReleaseEmail({ ...base, total: null }).html).not.toContain('Total:')
  })

  it('escapes the name, because it comes from the roster', () => {
    const m = invoiceReleaseEmail({ ...base, firstName: 'Ben & Co <script>' })
    expect(m.html).toContain('Ben &amp; Co &lt;script&gt;')
    expect(m.html).not.toContain('<script>')
  })

  it('paints its own background, so a dark-mode inbox cannot swallow the text', () => {
    // The bug lib/bam-copy-email.ts already fixed once: without this the near-black body
    // sits on whatever the client paints behind it.
    for (const m of [invoiceReleaseEmail(base), invoiceRevisedEmail({ ...base, previousTotal: 1 })]) {
      expect(m.html).toContain('background: #ffffff')
    }
  })

  it('carries a plain-text alternative, not just HTML', () => {
    for (const m of [invoiceReleaseEmail(base), invoiceRevisedEmail({ ...base, previousTotal: 1 })]) {
      expect(m.text.length).toBeGreaterThan(80)
      expect(m.text).not.toContain('<')
    }
  })
})
