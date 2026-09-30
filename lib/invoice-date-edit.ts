/**
 * An admin choosing the date printed on an invoice.
 *
 * The default is the 16th of the month being invoiced (lib/deadline.ts invoiceDateFor),
 * and that stays the rule. This exists because AP may count net-15 from the printed date,
 * and an invoice created on the 30th for a month that has closed would otherwise already
 * be two weeks old when it arrives (Lea Major, 2026-09).
 *
 * The date has to stay inside the month being invoiced, so "an invoice for September is
 * dated September" still holds, and it cannot be in the future.
 */
import { readableInvoiceDate } from './invoice-payload'

export type InvoiceDateEdit =
  | { ok: true; provided: false }
  | { ok: true; provided: true; iso: string; readable: string }
  | { ok: false; status: 400; message: string }

/** `raw` is what the client sent: undefined, null or '' means "leave the date alone". */
export function parseInvoiceDateEdit(raw: unknown, period: string, today: Date = new Date()): InvoiceDateEdit {
  if (raw === undefined || raw === null || raw === '') return { ok: true, provided: false }
  const text = typeof raw === 'string' ? raw.trim() : ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return { ok: false, status: 400, message: 'Invoice date must look like 2026-09-30.' }

  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const date = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0))
  // new Date rolls 2026-02-31 into March; the round trip catches it.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return { ok: false, status: 400, message: `${text} is not a real date.` }
  }

  const periodMonth = String(period).slice(0, 7)
  if (text.slice(0, 7) !== periodMonth) {
    const label = new Date(`${periodMonth}-01T00:00:00Z`).toLocaleString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    return { ok: false, status: 400, message: `This invoice is for ${label}, so its date has to be in ${label}.` }
  }

  const endOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59)
  if (date.getTime() > endOfToday) {
    return { ok: false, status: 400, message: 'An invoice cannot be dated in the future.' }
  }

  return { ok: true, provided: true, iso: date.toISOString(), readable: readableInvoiceDate(date) }
}
