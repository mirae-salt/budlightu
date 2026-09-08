/**
 * What Robin is shown when a receipt could not be read.
 *
 * The stored text is the upstream error verbatim, JSON and all. Jackson Bennett's row has
 * held this since 2026-09-05:
 *
 *   ocr_not_started: OCR endpoint returned 500. {"ok":false,"error":"OpenRouter 400:
 *   {\"error\":{\"message\":\"Invalid image data-url\",\"code\":400,...
 *
 * It names two vendors she has no relationship with and never says the thing that was
 * actually wrong, which is that the file he uploaded was zero bytes.
 */
import { describe, it, expect } from 'vitest'
import { explainOcrFailure, parseReason } from '../lib/receipt-reason'

/** Jackson Bennett's row, 2026-09-05. */
const JACKSON =
  'ocr_not_started: OCR endpoint returned 500. {"ok":false,"error":"OpenRouter 400: ' +
  '{\\"error\\":{\\"message\\":\\"Invalid image data-url\\",\\"code\\":400,\\"metadata\\":' +
  '{\\"provider_name\\":\\"Google AI Studio\\"}}}","user_id":"user_3GuQOpzWNf4riIYivUHi"}'

describe('explainOcrFailure', () => {
  it('names the real cause when the file is empty', () => {
    expect(explainOcrFailure(JACKSON, 0)).toMatch(/empty \(0 bytes\)/)
    expect(explainOcrFailure(JACKSON, 0)).toMatch(/upload the receipt again/)
  })

  it('falls back to the vendor signature when the size is unknown', () => {
    expect(explainOcrFailure(JACKSON)).toMatch(/did not contain a readable image/)
  })

  it.each([
    ['OpenRouter 429 rate limit exceeded', /busy/i],
    ['upstream ETIMEDOUT after 30s', /took too long/i],
    ['413 payload too large', /too large/i],
    ['401 unauthorized: invalid api key', /credentials/i],
    ['502 bad gateway', /failed on its side/i]
  ])('reads %s as something a person can act on', (raw, expected) => {
    expect(explainOcrFailure(raw)).toMatch(expected)
  })

  it('says something useful even for an error nobody has seen', () => {
    const out = explainOcrFailure('kablooie')
    expect(out).toMatch(/could not process this file/i)
    expect(out).not.toMatch(/kablooie/)
  })

  it('never leaks the vendor blob into what is displayed', () => {
    for (const bytes of [0, 860391, null, undefined]) {
      const out = explainOcrFailure(JACKSON, bytes)
      expect(out).not.toMatch(/OpenRouter|Google AI Studio|user_id|\{/)
    }
  })
})

describe('parseReason routes a failed read through the explainer', () => {
  it('replaces the blob and labels it plainly', () => {
    const [part] = parseReason(JACKSON, { storageBytes: 0 })
    expect(part.label).toBe('Could not read this file')
    expect(part.detail).toMatch(/empty \(0 bytes\)/)
    expect(part.detail.length).toBeLessThan(120)
  })

  it('leaves every other kind of reason exactly as it was', () => {
    const [part] = parseReason('over_balance: Bud Light total $88.00 exceeds available balance $60.00')
    expect(part.label).toBe('Over remaining balance')
    expect(part.detail).toBe('Bud Light total $88.00 exceeds available balance $60.00')
  })
})
