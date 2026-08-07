/**
 * PDF text safety (P1-9, audit 2026-08-07).
 *
 * lib/pdf-template.tsx renders with the built-in Helvetica of @react-pdf/renderer.
 * Standard-14 PDF fonts are WinAnsi (cp1252) encoded: any code point outside
 * that set is mapped to a *different* byte and printed as the wrong glyph with
 * no error at all. Observed: "Michał" -> "MichaB", NFD-decomposed "Émile" ->
 * "Emile".
 *
 * Two defences here:
 *   1. normalizeForPdf() recursively NFC-normalizes every string in the payload,
 *      which fixes the decomposed-accent case outright (NFD "E"+U+0301 -> "É",
 *      which WinAnsi does contain).
 *   2. Anything still outside WinAnsi is a HARD FAIL with the field path and the
 *      offending characters. No Unicode TTF is bundled in this repo and we will
 *      not fetch one at render time, so the only honest options are "block" or
 *      "print the wrong name on a payment document". We block.
 *
 * To lift the restriction later: bundle a TTF (e.g. NotoSans) under the repo,
 * Font.register() it in pdf-template.tsx, and relax isWinAnsiRenderable.
 */

/** Unicode code points that cp1252 / WinAnsiEncoding can actually represent. */
const WINANSI_EXTRA = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178
])

export function isWinAnsiRenderable(codePoint: number): boolean {
  if (codePoint === 0x0a) return true                       // react-pdf line break
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true    // ASCII printable
  if (codePoint >= 0xa1 && codePoint <= 0xff) return true    // Latin-1 supplement
  if (codePoint === 0xa0) return true                        // NBSP (renders as space)
  return WINANSI_EXTRA.has(codePoint)
}

export function unrenderableChars(s: string): string[] {
  const bad: string[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (!isWinAnsiRenderable(c)) {
      const label = `${JSON.stringify(ch)} (U+${c.toString(16).toUpperCase().padStart(4, '0')})`
      if (!bad.includes(label)) bad.push(label)
    }
  }
  return bad
}

export class PdfTextError extends Error {
  constructor(public readonly path: string, public readonly chars: string[], value: string) {
    super(
      `PDF render blocked: ${path} contains character(s) the invoice font cannot print: ${chars.join(', ')}. ` +
      `Value: ${JSON.stringify(value)}. ` +
      `Printing it would silently produce the wrong letters on a payment document. ` +
      `Fix the source data, or bundle a Unicode font and register it in lib/pdf-template.tsx.`
    )
    this.name = 'PdfTextError'
  }
}

/** NFC-normalize one string and hard-fail if it still cannot be rendered. */
export function pdfString(value: string, path: string): string {
  const normalized = value.normalize('NFC')
  const bad = unrenderableChars(normalized)
  if (bad.length) throw new PdfTextError(path, bad, value)
  return normalized
}

/**
 * Pre-flight check for callers that render a PDF.
 *
 * normalizeForPdf() also runs inside the component, but @react-pdf/renderer
 * mangles an exception thrown during its render into
 * "Cannot read properties of null (reading 'props')" — it still fails closed,
 * but the operator learns nothing. Call this first so the real reason (which
 * field, which character) reaches the admin UI.
 */
export function assertPdfRenderable(payload: unknown): void {
  normalizeForPdf(payload)
}

/**
 * Deep copy of the payload with every string NFC-normalized and verified.
 * Numbers/booleans/null pass through untouched, so amount and leading-zero
 * banking strings are never coerced (banking values stay strings — do not
 * introduce Number()/parseInt here).
 */
export function normalizeForPdf<T>(value: T, path = 'payload'): T {
  if (typeof value === 'string') return pdfString(value, path) as unknown as T
  if (Array.isArray(value)) {
    return value.map((v, i) => normalizeForPdf(v, `${path}[${i}]`)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeForPdf(v, `${path}.${k}`)
    }
    return out as unknown as T
  }
  return value
}
