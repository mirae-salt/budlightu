/**
 * The link on a student notification.
 *
 * The rest of notifyBam is an insert and cannot be tested without a database, but this part is
 * pure and it is the part that can send a student somewhere they are not allowed to go. The
 * admin bell links to /admin/* freely; the same call shape on the student side would produce a
 * notification that bounces off the middleware and reads as a broken portal.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { portalLink } from '../lib/notify-bam'

afterEach(() => { vi.restoreAllMocks() })

describe('portalLink', () => {
  it('keeps a portal path', () => {
    expect(portalLink('/portal/upload', 'receipt_approved')).toBe('/portal/upload')
    expect(portalLink('/portal/invoices?period=2026-09-01', 'invoice_sent'))
      .toBe('/portal/invoices?period=2026-09-01')
  })

  it('treats a missing link as no link, not as an error', () => {
    expect(portalLink(undefined, 'shortfall')).toBeNull()
  })

  it('refuses an admin path', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(portalLink('/admin/receipts', 'shortfall')).toBeNull()
    // Refusing quietly would turn a wrong link into a missing one with nothing to find later.
    expect(spy).toHaveBeenCalled()
  })

  it('refuses an absolute URL, which is how this becomes an open redirect', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(portalLink('https://example.com/portal/upload', 'invoice_sent')).toBeNull()
    expect(portalLink('//example.com/portal/upload', 'invoice_sent')).toBeNull()
  })

  it('refuses a path that only starts like the portal', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // /portalX/ is not /portal/, and a prefix check without the trailing slash would pass it.
    expect(portalLink('/portalsomething/upload', 'invoice_sent')).toBeNull()
    expect(portalLink('/portal', 'invoice_sent')).toBeNull()
  })
})
