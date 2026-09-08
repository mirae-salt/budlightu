/**
 * Files on a support thread.
 *
 * Theo Cliche, 2026-09-04, mid-thread about a receipt that would not upload: "It also does
 * not allow me to send you pictures on this log."
 *
 * The rules that matter here are the two that decide whose file somebody can read. Size
 * and type are enforced by the bucket, because the bytes never pass through our code.
 */
import { describe, it, expect } from 'vitest'
import {
  attachmentProblem,
  buildAttachmentKey,
  keyBelongsToBam,
  parseAttachmentInput,
  safeDownloadName,
  isViewableImage,
  SUPPORT_MAX_BYTES
} from '../lib/support-attachment'

const BAM = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'
const Q = '33333333-3333-3333-3333-333333333333'

describe('buildAttachmentKey', () => {
  it('is built from ids we own, never from the filename', () => {
    // A name arrives from someone's device and can hold a path. Building a key out of one
    // is how an object lands where it was not meant to.
    const key = buildAttachmentKey({ bamId: BAM, questionId: Q, mime: 'image/jpeg', random: 'abc' })
    expect(key).toBe(`${BAM}/${Q}/abc.jpg`)
  })

  it('takes the extension from the type, so "../../etc/passwd" cannot reach it', () => {
    const key = buildAttachmentKey({ bamId: BAM, questionId: '../../x', mime: 'application/pdf', random: 'r' })
    // The question id is checked against the caller's own threads before this is called,
    // so the only shapes that reach it are ids and the literal 'new'.
    expect(key.endsWith('.pdf')).toBe(true)
  })
})

describe('keyBelongsToBam', () => {
  it('accepts the owner and refuses everybody else', () => {
    const key = buildAttachmentKey({ bamId: BAM, questionId: Q, mime: 'image/png', random: 'r' })
    expect(keyBelongsToBam(key, BAM)).toBe(true)
    expect(keyBelongsToBam(key, OTHER)).toBe(false)
  })

  it('is not fooled by a bam id that merely starts the same way', () => {
    expect(keyBelongsToBam('abc-extra/q/r.jpg', 'abc')).toBe(false)
  })

  it('refuses empties rather than matching everything', () => {
    expect(keyBelongsToBam('', BAM)).toBe(false)
    expect(keyBelongsToBam('k', '')).toBe(false)
  })
})

describe('parseAttachmentInput', () => {
  const good = { key: `${BAM}/${Q}/r.jpg`, mime: 'image/jpeg', bytes: 1234, name: 'receipt.jpg' }

  it('no attachment is the normal case, not an error', () => {
    expect(parseAttachmentInput(undefined, BAM)).toEqual({ ok: true, columns: null })
    expect(parseAttachmentInput(null, BAM)).toEqual({ ok: true, columns: null })
    expect(parseAttachmentInput({}, BAM)).toEqual({ ok: true, columns: null })
  })

  it('turns a good one into columns', () => {
    const out = parseAttachmentInput(good, BAM)
    expect(out).toEqual({
      ok: true,
      columns: {
        attachment_key: good.key,
        attachment_mime: 'image/jpeg',
        attachment_bytes: 1234,
        attachment_name: 'receipt.jpg'
      }
    })
  })

  it('refuses a key belonging to somebody else', () => {
    // The key came back through the client, so it is checked against the session again.
    // Without this a message could claim any object in the bucket.
    const out = parseAttachmentInput(good, OTHER)
    expect(out.ok).toBe(false)
  })

  it('refuses a type the bucket would not take anyway', () => {
    expect(parseAttachmentInput({ ...good, mime: 'text/html' }, BAM).ok).toBe(false)
    expect(parseAttachmentInput({ ...good, mime: 'application/x-msdownload' }, BAM).ok).toBe(false)
  })

  it('refuses half an attachment', () => {
    expect(parseAttachmentInput({ key: good.key }, BAM).ok).toBe(false)
    expect(parseAttachmentInput({ mime: 'image/jpeg' }, BAM).ok).toBe(false)
  })

  it('keeps a nonsense size out of the column rather than storing it', () => {
    const out = parseAttachmentInput({ ...good, bytes: 'lots' }, BAM)
    expect(out.ok && out.columns?.attachment_bytes).toBe(null)
  })
})

describe('attachmentProblem', () => {
  it('catches an empty file, which cost Jackson Bennett a whole month', () => {
    expect(attachmentProblem({ name: 'a.jpg', type: 'image/jpeg', size: 0 })).toMatch(/empty/i)
  })

  it('says how big it is and what the limit is', () => {
    const msg = attachmentProblem({ name: 'a.jpg', type: 'image/jpeg', size: SUPPORT_MAX_BYTES + 1 })
    expect(msg).toMatch(/over the 20 MB limit/)
  })

  it('takes what a phone actually produces, including HEIC', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']) {
      expect(attachmentProblem({ name: 'a', type, size: 1000 })).toBe(null)
    }
  })

  it('turns anything else away with what it does take', () => {
    expect(attachmentProblem({ name: 'a.zip', type: 'application/zip', size: 1000 }))
      .toMatch(/JPG, PNG, WebP, HEIC.*PDF/)
  })
})

describe('safeDownloadName', () => {
  it('strips what would break out of a Content-Disposition header', () => {
    expect(safeDownloadName('re"ceipt\r\nX-Evil: 1.jpg', 'image/jpeg')).toBe('receiptX-Evil: 1.jpg')
  })

  it('flattens a path into a name', () => {
    expect(safeDownloadName('../../etc/passwd', 'application/pdf')).toBe('..-..-etc-passwd')
  })

  it('falls back to a name derived from the type', () => {
    expect(safeDownloadName(null, 'application/pdf')).toBe('attachment.pdf')
    expect(safeDownloadName('   ', 'image/png')).toBe('attachment.png')
  })
})

describe('isViewableImage', () => {
  it('shows what a browser can paint', () => {
    expect(isViewableImage('image/jpeg')).toBe(true)
    expect(isViewableImage('image/webp')).toBe(true)
  })

  it('links HEIC and PDF instead, because a broken image icon explains nothing', () => {
    expect(isViewableImage('image/heic')).toBe(false)
    expect(isViewableImage('application/pdf')).toBe(false)
    expect(isViewableImage(null)).toBe(false)
  })
})
