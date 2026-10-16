/**
 * A receipt line's amount as shown on the review screen.
 *
 * The OCR model leaves `total` null on lines that carry no price of their own (a
 * "+ 2 Glass" modifier under a pitcher). Calling `.toFixed` on that threw and blanked the
 * whole review page on 2026-10-16. Anything that is not a finite number reads as unreadable.
 */
export function formatLineTotal(total: unknown): string {
  return typeof total === 'number' && Number.isFinite(total) ? `$${total.toFixed(2)}` : 'unreadable'
}
