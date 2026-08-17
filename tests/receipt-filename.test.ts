/**
 * The name a saved receipt gets.
 *
 * Two things matter here. The month has to be on the file, because that was the whole
 * point: a Downloads folder full of "image.jpg" tells Robin nothing. And the string
 * ends up inside a Content-Disposition header, so anything that could terminate that
 * header or inject a new one has to be gone before it gets there.
 */
import { describe, it, expect } from 'vitest'
import { receiptDownloadFilename, monthLabelFromKey } from '../lib/receipt-filename'

const KEY = '04a46ef9-d6d5-4fa1-9b84-bb0deec5c54a/2026-08-01/a3f97c7d4b52aee5c92910005ff3637af2b22753.jpg'

describe('the month lands on the file', () => {
  it('reads the period out of the storage key', () => {
    expect(monthLabelFromKey(KEY)).toBe('August 2026')
  })

  it('names a receipt with month, and extension preserved', () => {
    const f = receiptDownloadFilename(KEY)
    expect(f).toContain('August 2026')
    expect(f.endsWith('.jpg')).toBe(true)
  })

  it('puts the BAM name first when the caller knows it', () => {
    expect(receiptDownloadFilename(KEY, 'Alex Kim')).toBe('Alex Kim - August 2026 - Receipt a3f97c.jpg')
  })

  it('still gives the month when no name is passed', () => {
    expect(receiptDownloadFilename(KEY)).toBe('August 2026 - Receipt a3f97c.jpg')
  })

  it('distinguishes two receipts from the same BAM in the same month', () => {
    const a = receiptDownloadFilename(`x/2026-08-01/aaaaaaaaaaaa.jpg`, 'Alex Kim')
    const b = receiptDownloadFilename(`x/2026-08-01/bbbbbbbbbbbb.jpg`, 'Alex Kim')
    expect(a).not.toBe(b)
  })

  it('handles every month boundary without off-by-one', () => {
    expect(monthLabelFromKey('x/2026-01-01/h.jpg')).toBe('January 2026')
    expect(monthLabelFromKey('x/2026-12-01/h.jpg')).toBe('December 2026')
  })
})

describe('it cannot break the header it goes into', () => {
  it('strips CR and LF, which would inject a header', () => {
    const f = receiptDownloadFilename(KEY, 'Alex\r\nX-Evil: 1')
    expect(f).not.toContain('\r')
    expect(f).not.toContain('\n')
    expect(f).toContain('August 2026')
  })

  it('strips the double quote, which would end the value early', () => {
    const f = receiptDownloadFilename(KEY, 'Alex" ; filename="evil.exe')
    expect(f).not.toContain('"')
  })

  it('strips slashes, because a filename is not a path', () => {
    const f = receiptDownloadFilename(KEY, '../../etc/passwd')
    expect(f).not.toContain('/')
    expect(f).not.toContain('\\')
  })

  it('does not let a crafted extension through', () => {
    // The key is system-generated, but this reaches a header either way.
    const f = receiptDownloadFilename('x/2026-08-01/h.jp"g', 'Alex')
    expect(f).not.toContain('"')
    expect(f.endsWith('.jpg')).toBe(true)
  })

  it('caps a very long name rather than emitting an enormous header', () => {
    const f = receiptDownloadFilename(KEY, 'A'.repeat(500))
    expect(f.length).toBeLessThan(120)
  })
})

describe('a bad key degrades, it never throws', () => {
  it('falls back to Receipt when there is no period segment', () => {
    // Naming a download must not be able to fail the download. No month is available
    // here, so the file gets the hash only, truncated to HASH_CHARS.
    expect(receiptDownloadFilename('nonsense')).toBe('Receipt nonsen.jpg')
  })

  it('survives empty and nullish input', () => {
    expect(() => receiptDownloadFilename('')).not.toThrow()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => receiptDownloadFilename(null as any)).not.toThrow()
    expect(monthLabelFromKey('')).toBe(null)
  })

  it('rejects an impossible month rather than printing "Invalid Date"', () => {
    expect(monthLabelFromKey('x/2026-13-01/h.jpg')).toBe(null)
    expect(receiptDownloadFilename('x/2026-13-01/h.jpg')).not.toContain('Invalid')
  })

  it('uses jpg when the key carries no extension', () => {
    expect(receiptDownloadFilename('x/2026-08-01/abcdef')).toBe('August 2026 - Receipt abcdef.jpg')
  })
})
