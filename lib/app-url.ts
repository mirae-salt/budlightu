/**
 * Resolves the public base URL used in emailed links.
 *
 * The raw env value is sanitized because an invisible BOM (U+FEFF) or stray
 * whitespace prepended to the value silently corrupts every link we email:
 * a BOM before "https://" makes the URL invalid, so mail clients refuse to
 * linkify it and pasting it into a browser fails. Trailing slashes are dropped
 * so callers can always append an absolute path.
 */
const FALLBACK = 'https://budlightu.com'

/** Drops BOM, zero-width and control characters that break URLs. */
function stripInvisible(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    const invisible =
      c === 0xfeff ||            // BOM
      (c >= 0x200b && c <= 0x200f) || // zero-width + bidi marks
      c < 0x20 ||                // control chars
      c === 0x7f
    if (!invisible) out += ch
  }
  return out
}

export function appBaseUrl(): string {
  const clean = stripInvisible(process.env.NEXT_PUBLIC_APP_URL ?? '')
    .trim()
    .replace(/\/+$/, '')
  return clean || FALLBACK
}
