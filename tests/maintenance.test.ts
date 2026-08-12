/**
 * A maintenance switch that blocks the person holding it is unfixable from the app.
 * This week already produced two versions of that shape -- admins locked out by the
 * sign-in gate, every new BAM bounced off the invite link -- so the escape hatches are
 * pinned here rather than trusted to a layout file.
 */
import { describe, it, expect } from 'vitest'
import {
  shouldShowMaintenance,
  shouldShowBanner,
  parseMaintenance,
  validateMaintenanceInput,
  DEFAULT_MESSAGE,
  DEFAULT_BANNER_MESSAGE,
  MAINTENANCE_OFF,
  MAX_MESSAGE_LENGTH,
  type MaintenanceState
} from '../lib/maintenance'

const BLOCK: MaintenanceState = { on: true, mode: 'block', message: 'brb', until: null }
const BANNER: MaintenanceState = { on: true, mode: 'banner', message: 'deploying at 8pm', until: null }
const ON = BLOCK  // the historical fixture name, kept so the cases below read the same

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

describe('banner mode', () => {
  it('a banner never takes the page away', () => {
    // The whole point of the mode split: the common case is a notice, not a wall.
    expect(shouldShowMaintenance({ state: BANNER, path: '/portal/dashboard', isAdmin: false })).toBe(false)
  })

  it('a banner shows on portal pages, including sign-in', () => {
    expect(shouldShowBanner({ state: BANNER, path: '/portal/dashboard' })).toBe(true)
    expect(shouldShowBanner({ state: BANNER, path: '/portal/login' })).toBe(true)
  })

  it('a banner shows to admins too', () => {
    // Information, not an obstacle. An admin should see at a glance that it is live
    // rather than having to open a private window.
    expect(shouldShowBanner({ state: BANNER, path: '/admin' })).toBe(true)
  })

  it('a block does not also draw a banner', () => {
    expect(shouldShowBanner({ state: BLOCK, path: '/portal/dashboard' })).toBe(false)
  })

  it('no banner when off, or when unreadable', () => {
    expect(shouldShowBanner({ state: MAINTENANCE_OFF, path: '/portal/dashboard' })).toBe(false)
    expect(shouldShowBanner({ state: null, path: '/portal/dashboard' })).toBe(false)
  })

  it('an unrecognised mode reads as a banner, not a block', () => {
    // The quieter of the two is the safe thing to land on from a bad value.
    const parsed = parseMaintenance({ on: true, mode: 'BLOCK', message: 'x' })
    expect(parsed.mode).toBe('banner')
    expect(shouldShowMaintenance({ state: parsed, path: '/portal/dashboard', isAdmin: false })).toBe(false)
  })

  it('only the literal "block" blocks', () => {
    expect(parseMaintenance({ on: true, mode: 'block' }).mode).toBe('block')
  })

  it('the write path refuses a mode it does not recognise', () => {
    expect(validateMaintenanceInput({ on: true, mode: 'loud' }).ok).toBe(false)
    expect(validateMaintenanceInput({ on: true }).ok).toBe(false)
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

  it('falls back to a mode-appropriate message when blank', () => {
    // Two fallbacks, because "the portal is down, try again in a few minutes" is wrong
    // text for a banner that is not taking anything down.
    expect(parseMaintenance({ on: true, mode: 'block', message: '   ' }).message).toBe(DEFAULT_MESSAGE)
    expect(parseMaintenance({ on: true, mode: 'banner', message: '   ' }).message).toBe(DEFAULT_BANNER_MESSAGE)
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
    const r = validateMaintenanceInput({ on: false, mode: 'block', message: 'x', until: '2026-08-12T10:00:00Z' })
    expect(r.ok && r.value).toEqual(MAINTENANCE_OFF)
  })

  it('rejects an over-long message', () => {
    const r = validateMaintenanceInput({ on: true, mode: 'block', message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) })
    expect(r.ok).toBe(false)
  })

  it('rejects an unreadable until instead of silently dropping it', () => {
    // On the write path a bad value is the admin's typo, so say so. parseMaintenance
    // drops it on the read path because a stored bad value must not break the page.
    expect(validateMaintenanceInput({ on: true, mode: 'block', until: 'in a bit' }).ok).toBe(false)
  })

  it('accepts a blank message and substitutes the default', () => {
    const r = validateMaintenanceInput({ on: true, mode: 'block', message: '  ' })
    expect(r.ok && r.value.message).toBe(DEFAULT_MESSAGE)
  })
})
