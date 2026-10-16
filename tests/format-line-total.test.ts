/**
 * The lines below are copied from receipt 23d9fbb1 (NICHE LOUNGE), the one that crashed the
 * admin review page on 2026-10-16 because the "+ 2 Glass" line had total: null.
 */
import { describe, it, expect } from 'vitest'
import { formatLineTotal } from '../lib/format-line-total'

const LINES = [
  { desc: '0.5x PITCHER BUD LIGHT', total: 9.37 },
  { desc: '+ 2 Glass', total: null },
  { desc: '1x GLS BUD LIGHT', total: 6.25 }
]

describe('formatLineTotal', () => {
  it('does not throw on the real receipt and marks the blank line', () => {
    expect(LINES.map(l => formatLineTotal(l.total))).toEqual(['$9.37', 'unreadable', '$6.25'])
  })
  it('treats missing and non-numeric values as unreadable', () => {
    for (const v of [undefined, null, NaN, Infinity, '12.00']) expect(formatLineTotal(v)).toBe('unreadable')
  })
  it('keeps zero as a real amount', () => {
    expect(formatLineTotal(0)).toBe('$0.00')
  })
})
