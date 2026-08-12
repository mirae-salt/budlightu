/**
 * Where the notification panel opens.
 *
 * The bell moved from the top of the sidebar to the account row at the bottom on 2026-08-12.
 * The panel was hardcoded to open downward from the button, so from its new position a 480px
 * panel ran straight off the bottom of the window: notifications rendered and unreadable.
 * Mirae found it immediately.
 *
 * Extracted as a pure function because "does the panel fit on screen" is a question about
 * arithmetic, and arithmetic can be checked without a browser.
 */
import { describe, it, expect } from 'vitest'
import { placePanel } from '../app/admin/_components/TopBar'

const VIEW = { width: 1280, height: 800 }

/** The bell in its new home: bottom of the sidebar. */
const BOTTOM_BELL = { top: 742, bottom: 770, left: 200 }
/** Where it used to be. */
const TOP_BELL = { top: 24, bottom: 52, left: 200 }

describe('the panel stays on screen', () => {
  it('opens upward from the bottom of the sidebar', () => {
    const p = placePanel(BOTTOM_BELL, VIEW)
    expect(p.top).toBeLessThan(BOTTOM_BELL.top)
    // The actual bug: top + maxHeight used to be 1258 against an 800px window.
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(VIEW.height)
    expect(p.top).toBeGreaterThanOrEqual(0)
  })

  it('still opens downward when there is room, which is what people expect', () => {
    const p = placePanel(TOP_BELL, VIEW)
    expect(p.top).toBeGreaterThan(TOP_BELL.bottom)
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(VIEW.height)
  })

  it('fits inside a short laptop window either way', () => {
    // 1366x768 is inside the range that already clipped the log out button once.
    for (const r of [BOTTOM_BELL, TOP_BELL, { top: 400, bottom: 428, left: 200 }]) {
      const p = placePanel(r, { width: 1366, height: 768 })
      expect(p.top).toBeGreaterThanOrEqual(0)
      expect(p.top + p.maxHeight).toBeLessThanOrEqual(768)
    }
  })

  it('never returns a panel too short to read', () => {
    // A cramped window should scroll inside the panel, not shrink it to a sliver.
    const p = placePanel({ top: 300, bottom: 330, left: 200 }, { width: 400, height: 640 })
    expect(p.maxHeight).toBeGreaterThanOrEqual(200)
  })
})

describe('the panel stays inside the left and right edges', () => {
  it('is narrower than a phone screen rather than 380px wide', () => {
    const p = placePanel({ top: 100, bottom: 128, left: 20 }, { width: 375, height: 812 })
    expect(p.width).toBeLessThanOrEqual(375)
    expect(p.left + p.width).toBeLessThanOrEqual(375)
    expect(p.left).toBeGreaterThanOrEqual(0)
  })

  it('slides left instead of overflowing when the button is near the right edge', () => {
    const p = placePanel({ top: 100, bottom: 128, left: 1240 }, VIEW)
    expect(p.left).toBeLessThan(1240)
    expect(p.left + p.width).toBeLessThanOrEqual(VIEW.width)
  })

  it('keeps the full width when there is room', () => {
    expect(placePanel(TOP_BELL, VIEW).width).toBe(380)
  })
})
