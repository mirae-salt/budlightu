/**
 * Resolves the public base URL used in emailed links.
 *
 * The raw env value is sanitized because an invisible BOM (U+FEFF) or stray
 * whitespace prepended to the value silently corrupts every link we email:
 * a BOM before "https://" makes the URL invalid, so mail clients refuse to
 * linkify it and pasting it into a browser fails. Trailing slashes are dropped
 * so callers can always append an absolute path.
 *
 * The sanitizers themselves now live in `lib/sanitize.ts` so the AP send path,
 * the Graph calls and the roster writes all share one implementation. They are
 * re-exported here because this module was the original home and callers
 * already import `stripInvisible` from this path.
 */
import { stripInvisible, envAddress, envAddressList, envString } from './sanitize'

export { stripInvisible, envAddress, envAddressList, envString }

const FALLBACK = 'https://budlightu.com'

export function appBaseUrl(): string {
  const clean = stripInvisible(process.env.NEXT_PUBLIC_APP_URL ?? '')
    .trim()
    .replace(/\/+$/, '')
  return clean || FALLBACK
}
