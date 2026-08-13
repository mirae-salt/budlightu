/**
 * The AP address rules.
 *
 * This is the money path: the value these functions accept decides which inbox receives an
 * invoice, and the failure is invisible because the send still succeeds. The write path and
 * the read path share these functions on purpose, so what is asserted here is that a value
 * which can be STORED is a value which will RESOLVE.
 */
import { describe, it, expect } from 'vitest'
import {
  apAddressProblems,
  normalizeApAddresses,
  parseApAddresses
} from '../lib/ap-addresses'

describe('normalizeApAddresses', () => {
  it('accepts a comma string or an array for cc', () => {
    expect(normalizeApAddresses({ to: 'ap@x.com', cc: 'a@x.com, b@x.com' }))
      .toEqual({ to: 'ap@x.com', cc: ['a@x.com', 'b@x.com'] })
    expect(normalizeApAddresses({ to: 'ap@x.com', cc: ['a@x.com', 'b@x.com'] }))
      .toEqual({ to: 'ap@x.com', cc: ['a@x.com', 'b@x.com'] })
  })

  it('drops empty cc entries, so a trailing comma is not an error', () => {
    expect(normalizeApAddresses({ to: 'ap@x.com', cc: 'a@x.com, ,' }).cc).toEqual(['a@x.com'])
  })

  it('strips the invisible characters that make a wrong address look right', () => {
    // U+FEFF is the 2026-08-07 incident. It survives trim() in some paths and is invisible in
    // every log and every text field.
    const out = normalizeApAddresses({ to: '﻿ap@x.com ', cc: ['​b@x.com'] })
    expect(out.to).toBe('ap@x.com')
    expect(out.cc).toEqual(['b@x.com'])
  })

  it('folds a non-breaking space to a real space rather than deleting it', () => {
    // Deleting it would turn "a b@x.com" into the perfectly valid-looking "ab@x.com" and send
    // an invoice to an address nobody typed. Folding leaves a space, which the validator
    // rejects, so the person retypes it.
    const out = normalizeApAddresses({ to: 'a b@x.com', cc: [] })
    expect(out.to).toBe('a b@x.com')
    expect(apAddressProblems(out).length).toBeGreaterThan(0)
  })
})

describe('apAddressProblems', () => {
  it('passes a clean pair', () => {
    expect(apAddressProblems({ to: 'ap@x.com', cc: ['a@x.com', 'b@x.com'] })).toEqual([])
  })

  it('allows no cc at all', () => {
    expect(apAddressProblems({ to: 'ap@x.com', cc: [] })).toEqual([])
  })

  it('refuses an empty recipient', () => {
    expect(apAddressProblems({ to: '', cc: [] })).toHaveLength(1)
  })

  it('reports every bad address, not only the first', () => {
    const problems = apAddressProblems({ to: 'not-an-address', cc: ['also bad', 'worse'] })
    expect(problems).toHaveLength(3)
  })

  it('refuses a second recipient smuggled into one field', () => {
    // A comma inside `to` would put two addresses in a header from one input.
    expect(apAddressProblems({ to: 'ap@x.com,other@y.com', cc: [] })).toHaveLength(1)
  })

  it('catches a duplicate between to and cc', () => {
    const problems = apAddressProblems({ to: 'ap@x.com', cc: ['AP@x.com'] })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('more than once')
  })
})

describe('parseApAddresses', () => {
  it('reads a stored value', () => {
    expect(parseApAddresses({ to: 'ap@x.com', cc: ['a@x.com'] }))
      .toEqual({ to: 'ap@x.com', cc: ['a@x.com'] })
  })

  it('returns null for anything unusable, which the caller treats as refuse', () => {
    // NOT as "fall back to env". A stored value that silently reverts means a bad edit looks
    // like it worked while the money keeps going to the old place.
    expect(parseApAddresses(null)).toBeNull()
    expect(parseApAddresses('ap@x.com')).toBeNull()
    expect(parseApAddresses([])).toBeNull()
    expect(parseApAddresses({ cc: ['a@x.com'] })).toBeNull()
    expect(parseApAddresses({ to: '   ' })).toBeNull()
  })

  it('a stored value with no cc is usable, not broken', () => {
    expect(parseApAddresses({ to: 'ap@x.com' })).toEqual({ to: 'ap@x.com', cc: [] })
  })
})
