/**
 * The email a BAM receives with their invoice.
 *
 * This used to exist twice: a plain-text version that actually went out, and a
 * branded HTML version with no caller. The subject of the live one carried an em
 * dash, and its body told students to visit "the support page in your portal"
 * without giving an address.
 */
import { describe, it, expect } from 'vitest'
import { bamCopyEmail, escapeHtml } from '../lib/bam-copy-email'

const URL = 'https://budlightu.com/portal/invoices'

describe('bamCopyEmail', () => {
  const mail = bamCopyEmail('Isla', 'September', 'INV-IO1', URL, true)

  it('has no em dash anywhere', () => {
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toContain('—')
    }
  })

  it('names the month in the subject without the old prefix', () => {
    expect(mail.subject).toBe('Your September invoice is ready')
  })

  it('gives the portal address rather than describing where it is', () => {
    expect(mail.text).toContain(URL)
    expect(mail.html).toContain(`href="${URL}"`)
  })

  it('carries both a text and an HTML part', () => {
    // The text alternative is what a spam filter reads.
    expect(mail.text.length).toBeGreaterThan(0)
    expect(mail.html).toContain('<div')
  })

  it('addresses the student and names the invoice', () => {
    expect(mail.text).toContain('Hi Isla,')
    expect(mail.text).toContain('INV-IO1')
    expect(mail.html).toContain('Hi Isla,')
    expect(mail.html).toContain('INV-IO1')
  })

  it('says attached when there is an attachment and ready when there is not', () => {
    expect(bamCopyEmail('Isla', 'September', 'INV-IO1', URL, true).text).toContain('is attached')
    const none = bamCopyEmail('Isla', 'September', 'INV-IO1', URL, false)
    expect(none.text).toContain('is ready')
    expect(none.text).not.toContain('is attached')
    expect(none.html).not.toContain('attached')
  })

  it('does not promise payment terms', () => {
    // The signed contract says Net 30. Quoting net-15 here would be a date
    // nobody agreed to, so the email states none at all.
    for (const part of [mail.text, mail.html]) {
      expect(part).not.toMatch(/net.?15/i)
      expect(part).not.toMatch(/net.?30/i)
    }
  })

  it('escapes a name carrying markup, in the HTML part only', () => {
    const m = bamCopyEmail('A<b>&"', 'September', 'INV-X1', URL, true)
    expect(m.html).toContain('A&lt;b&gt;&amp;&quot;')
    expect(m.html).not.toContain('<b>')
    // The plain-text part must NOT be escaped, or a student sees "&amp;".
    expect(m.text).toContain('A<b>&"')
  })

  it('leaves an ordinary apostrophe alone', () => {
    // O'Sullivan is a real BAM. Escaping the apostrophe would show &#39; to her.
    const m = bamCopyEmail("Isla O'Sullivan", 'September', 'INV-IO1', URL, true)
    expect(m.html).toContain("Isla O'Sullivan")
  })
})

describe('escapeHtml', () => {
  it('covers the four characters that break an attribute or a tag', () => {
    expect(escapeHtml('&<>"')).toBe('&amp;&lt;&gt;&quot;')
  })

  it('escapes the ampersand first, so an escape is not double escaped', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})
