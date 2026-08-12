/**
 * The invite link was broken in production by an exact-match exemption:
 * `path !== '/portal/onboarding'` left `/portal/onboarding/<token>` protected, so every
 * new BAM -- who has no session by definition -- was 307'd to the login page instead of
 * their pre-filled form. Confirmed against production with no cookies before the fix:
 *
 *   GET /portal/onboarding/<uuid>  ->  307  /portal/login
 *   GET /portal/faq                ->  200
 *
 * These cases pin both directions: what must stay open, and what must stay closed.
 */
import { describe, it, expect } from 'vitest'
import { needsPortalAuth, needsAdminAuth, isPublicPortalPath } from '../lib/route-gate'

describe('needsPortalAuth — must stay OPEN', () => {
  it('lets an invite link through (the bug)', () => {
    expect(needsPortalAuth('/portal/onboarding/cb50fe24-1234-4000-8000-abcdef123456')).toBe(false)
  })

  it('lets the bare onboarding form through', () => {
    expect(needsPortalAuth('/portal/onboarding')).toBe(false)
  })

  it('lets the sign-in page through', () => {
    expect(needsPortalAuth('/portal/login')).toBe(false)
  })

  it('lets the FAQ and program pages through', () => {
    expect(needsPortalAuth('/portal/faq')).toBe(false)
    expect(needsPortalAuth('/portal/program')).toBe(false)
  })

  it('lets the terms page through, because the onboarding form links to it', () => {
    // The student reads the terms while filling in the form, before any session
    // exists. A protected terms page makes the consent checkbox unanswerable.
    expect(needsPortalAuth('/portal/terms')).toBe(false)
  })

  it('lets first-login account verification through', () => {
    expect(needsPortalAuth('/portal/verify-account')).toBe(false)
    expect(needsPortalAuth('/portal/verify-account/confirm')).toBe(false)
  })
})

describe('needsPortalAuth — must stay CLOSED', () => {
  it.each([
    '/portal/dashboard',
    '/portal/upload',
    '/portal/invoices',
    '/portal/invoices/abc-123',
    '/portal/account',
    '/portal/support'
  ])('requires a session for %s', path => {
    expect(needsPortalAuth(path)).toBe(true)
  })

  it('does not treat a lookalike prefix as public', () => {
    // '/portal/onboardingsecrets' must not inherit the onboarding exemption. A bare
    // startsWith would have let this through.
    expect(needsPortalAuth('/portal/onboardingsecrets')).toBe(true)
    expect(needsPortalAuth('/portal/terms-internal')).toBe(true)
    expect(needsPortalAuth('/portal/faq-admin')).toBe(true)
  })

  it('fails closed for a portal page nobody listed', () => {
    expect(needsPortalAuth('/portal/some-future-page')).toBe(true)
  })
})

describe('needsAdminAuth', () => {
  it('covers the admin UI', () => {
    expect(needsAdminAuth('/admin')).toBe(true)
    expect(needsAdminAuth('/admin/roster')).toBe(true)
  })

  it('covers the admin API, which the outer fence used to miss', () => {
    // /api/admin/data holds the service role key and returns every BAM's roster row.
    expect(needsAdminAuth('/api/admin/data')).toBe(true)
    expect(needsAdminAuth('/api/admin/team')).toBe(true)
  })

  it('does not claim portal paths', () => {
    expect(needsAdminAuth('/portal/dashboard')).toBe(false)
    expect(needsAdminAuth('/api/portal/upload')).toBe(false)
  })
})

describe('isPublicPortalPath', () => {
  it('is not fooled by a path that merely contains a public segment', () => {
    expect(isPublicPortalPath('/portal/dashboard/terms')).toBe(false)
  })

  it('matches a public prefix only at a path boundary', () => {
    expect(isPublicPortalPath('/portal/onboarding/x')).toBe(true)
    expect(isPublicPortalPath('/portal/onboardingx')).toBe(false)
  })
})
