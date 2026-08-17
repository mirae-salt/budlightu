/**
 * The filename an admin gets when they save a receipt image.
 *
 * WHY THIS EXISTS
 * ---------------
 * The storage key is `{bam_id}/{YYYY-MM-01}/{sha256}.{ext}` — correct for storage,
 * useless to a human. `/api/admin/receipts/image` sent no Content-Disposition at all,
 * so a browser saving from the lightbox named the file after the route: "image", or
 * "image.jpg". Robin ends up with a Downloads folder of identical names and no way to
 * tell which month, or which BAM, any of them belong to.
 *
 * Mirrors invoicePdfFilename in lib/invoice-numbering.ts, which already solved this
 * for invoices ("Alex Kim - July 2026 - Invoice #INV-AK1.pdf"). Same shape so the two
 * kinds of file sort together and read the same way.
 *
 * THE MONTH COMES FROM THE KEY, NOT FROM THE CALLER. The period is already in the
 * storage key and the key is what was actually downloaded, so the month on the
 * filename cannot disagree with the file's contents. A `name` passed in is only a
 * label and is sanitized; if it is missing or unusable the month still lands.
 */

/** Kept short so several receipts in one month stay distinguishable without being noisy. */
const HASH_CHARS = 6

/**
 * Control characters and DEL, tested by codepoint rather than by a character class.
 *
 * This started as a regex and the range came out as literal control BYTES in the
 * source. It worked, and it was invisible: `cat -A` was the only way to see what the
 * class actually held. This codebase has already lost rounds to an invisible byte
 * (the 2026-08-07 BOM incident), so anything you cannot read in the editor does not
 * ship. Comparing numbers has no escaping to get wrong.
 */
function isControlChar(codePoint: number): boolean {
  return codePoint < 0x20 || codePoint === 0x7f
}

/** Reserved on Windows and in a quoted header value. A filename is not a path. */
const UNSAFE_CHARS = /["\\/:*?<>|]/g

/**
 * Strip anything that could break a header or escape a directory.
 *
 * A filename ends up inside `Content-Disposition: inline; filename="..."`. A CR or LF
 * would let a caller inject a header and a quote would end the value early, so both
 * classes are removed rather than escaped.
 */
function sanitizeLabel(raw: string): string {
  return raw
    .split('').map(ch => (isControlChar(ch.charCodeAt(0)) ? ' ' : ch)).join('')
    .replace(UNSAFE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

/** "2026-08-01" -> "August 2026". Returns null when the segment is not a period. */
export function monthLabelFromKey(storageKey: string): string | null {
  const parts = String(storageKey ?? '').split('/')
  // The period is the second of three segments. Anything else is not a receipt key.
  const period = parts.length >= 3 ? parts[1] : null
  const m = period ? /^(\d{4})-(\d{2})-\d{2}$/.exec(period) : null
  if (!m) return null
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  const d = new Date(Date.UTC(Number(m[1]), month - 1, 1))
  return `${d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${m[1]}`
}

/**
 * The name to put on a saved receipt.
 *
 * `name` is the BAM's display name when the caller knows it (the review queue already
 * renders it, so passing it costs no extra query). Omit it and the month still leads.
 *
 * Always returns something usable: an unparseable key degrades to "Receipt" rather
 * than throwing, because failing to name a download must not fail the download.
 */
export function receiptDownloadFilename(storageKey: string, name?: string | null): string {
  const key = String(storageKey ?? '')
  const month = monthLabelFromKey(key)

  const last = key.split('/').pop() ?? ''
  const dot = last.lastIndexOf('.')
  // Extension letters only. The key is system-generated, but this string reaches a
  // header, and "jpg" is the honest fallback for the one bucket this serves.
  const rawExt = dot > 0 ? last.slice(dot + 1) : ''
  const ext = /^[A-Za-z0-9]{1,5}$/.test(rawExt) ? rawExt.toLowerCase() : 'jpg'
  const hash = (dot > 0 ? last.slice(0, dot) : last).replace(/[^A-Za-z0-9]/g, '').slice(0, HASH_CHARS)

  const label = name ? sanitizeLabel(name) : ''

  const parts = [
    ...(label ? [label] : []),
    ...(month ? [month] : []),
    hash ? `Receipt ${hash}` : 'Receipt'
  ]
  return `${parts.join(' - ')}.${ext}`
}
