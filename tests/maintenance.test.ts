/**
 * A maintenance switch that blocks the person holding it is unfixable from the app.
 * This week already produced two versions of that shape -- admins locked out by the
 * sign-in gate, every new BAM bounced off the invite link -- so the escape hatches are
 * pinned here rather than trusted to a layout file.
 */
import { describe, it, expect } from 'vitest'
import {
  shouldShowMaintenance,
  parseMaintenance,
  validateMaintenanceInput,
  DEFAULT_MESSAGE,
  MAINTENANCE_OFF,
  MAX_MESSAGE_LENGTH,
  type MaintenanceState
} from '../lib/maintenance'

const ON: MaintenanceState = { on: true, message: 'brb', until: null }

describe('shouldShowMaintenance — the escape hatches', () => {
  it('never blocks the sign-in page', () => {
    // The way back in. An admin who is not signed in yet has no role to bypass with,
    // so blocking this would leave nobody able to turn the switch off.
    expect(shouldShowMaintenance({ state: ON, path: '/portal/login', isAdmin: false })).toBe(false)
  })

  it('never blocks an admin', () => {
    expect(shouldShowMaintenance({ state: ON, path: '/portal/dashboard', isAdmin: true })).toBe(false)
  })

  it('never blocks /admin, where the off switch lives', () => {
    expect(shouldShowMaintenance({ state: ON, path: '/admin', isAdmin: false })).toBe(false)
    expect(shouldShowMaintenance({ state: ON, path: '/admin/maintenance', isAdmin: false })).toBe(false)
  })
})

describe('shouldShowMaintenance — when it does show', () => {
  it.each([
    '/portal/dashboard',
    '/portal/upload',
    '/portal/invoices',
    '/portal/account',
    '/portal/support',
    '/portal/faq',
    '/portal/terms',
    '/portal/onboarding',
    '/portal/onboarding/some-token'
  ])('blocks %s for a student', path => {
    expect(shouldShowMaintenance({ state: ON, path, isAdmin: false })).toBe(true)
  })

  it('does not touch pages outside the portal', () => {
    expect(shouldShowMaintenance({ state: ON, path: '/', isAdmin: false })).toBe(false)
  })
})

describe('shouldShowMaintenance — fails open', () => {
  it('shows nothing when the state could not be read', () => {
    // The opposite of the auth gates on purpose: a read failure must not become an
    // outage. See the header of lib/maintenance.ts.
    expect(shouldShowMaintenance({ state: null, path: '/portal/dashboard', isAdmin: false })).toBe(false)
  })

  it('shows nothing when the switch is off', () => {
    expect(shouldShowMaintenance({ state: MAINTENANCE_OFF, path: '/portal/dashboard', isAdmin: false })).toBe(false)
  })
})

describe('parseMaintenance', () => {
  it('only a real boolean true turns it on', () => {
    // A malformed row must not put the portal into maintenance nobody asked for.
    expect(parseMaintenance({ on: 'true' }).on).toBe(false)
    expect(parseMaintenance({ on: 1 }).on).toBe(false)
    expect(parseMaintenance({ on: true }).on).toBe(true)
  })

  it('treats junk as off', () => {
    expect(parseMaintenance(null).on).toBe(false)
    expect(parseMaintenance('on').on).toBe(false)
    expect(parseMaintenance([{ on: true }]).on).toBe(false)
  })

  it('falls back to the default message when blank', () => {
    expect(parseMaintenance({ on: true, message: '   ' }).message).toBe(DEFAULT_MESSAGE)
  })

  it('drops an unparseable until rather than showing Invalid Date', () => {
    expect(parseMaintenance({ on: true, until: 'soon' }).until).toBeNull()
  })

  it('normalizes a valid until to ISO', () => {
    expect(parseMaintenance({ on: true, until: '2026-08-12T10:00:00Z' }).until)
      .toBe('2026-08-12T10:00:00.000Z')
  })
})

describe('validateMaintenanceInput', () => {
  it('requires an explicit on/off', () => {
    expect(validateMaintenanceInput({ message: 'brb' }).ok).toBe(false)
  })

  it('ignores message and until when turning off', () => {
    const r = validateMaintenanceInput({ on: false, message: 'x', until: '2026-08-12T10:00:00Z' })
    expect(r.ok && r.value).toEqual(MAINTENANCE_OFF)
  })

  it('rejects an over-long message', () => {
    const r = validateMaintenanceInput({ on: true, message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) })
    expect(r.ok).toBe(false)
  })

  it('rejects an unreadable until instead of silently dropping it', () => {
    // On the write path a bad value is the admin's typo, so say so. parseMaintenance
    // drops it on the read path because a stored bad value must not break the page.
    expect(validateMaintenanceInput({ on: true, until: 'in a bit' }).ok).toBe(false)
  })

  it('accepts a blank message and substitutes the default', () => {
    const r = validateMaintenanceInput({ on: true, message: '  ' })
    expect(r.ok && r.value.message).toBe(DEFAULT_MESSAGE)
  })
})
