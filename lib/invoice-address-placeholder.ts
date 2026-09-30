/**
 * An invoice may exist before the student's mailing address does. It may not leave.
 *
 * Until 2026-09-30 a missing address stopped the invoice from being created at all
 * (P0-E), because an invoice whose address block read ", ," had once gone to AP. That
 * rule was right about the document and wrong about where to stop it: Lea Major had an
 * approved reimbursement in September, no address on file, and therefore no invoice for
 * anyone to see, fix or send. The office could not even tell she was owed.
 *
 * So the block moved from creation to sending. A draft is built with the words below
 * where the address goes and `addressPending` listing what is missing. batch-approve and
 * send-ap refuse any invoice that carries it, with the reason spelled out. Filling the
 * address in on the roster, or the student finishing onboarding, rewrites the draft with
 * the real address and clears the mark.
 */

export const ADDRESS_FIELDS = ['street', 'city', 'prov', 'postal'] as const
export type AddressField = typeof ADDRESS_FIELDS[number]

export const STREET_PLACEHOLDER = 'ADDRESS NOT ON FILE'
export const CITY_LINE_PLACEHOLDER = 'TO BE CONFIRMED'

const LABEL: Record<AddressField, string> = {
  street: 'street',
  city: 'city',
  prov: 'province',
  postal: 'postal code'
}

/** Which of the four address fields are blank. Whitespace is blank. */
export function missingAddressFields(row: Partial<Record<AddressField, unknown>>): AddressField[] {
  return ADDRESS_FIELDS.filter(f => !String(row[f] ?? '').trim())
}

/**
 * Why this invoice cannot be sent for lack of an address, or null when it can.
 *
 * Reads the mark first and the placeholder text second, so a payload that lost the mark
 * somewhere still cannot reach AP with "ADDRESS NOT ON FILE" printed on it.
 */
export function addressPendingProblem(payload: unknown): string | null {
  const p = (payload ?? {}) as { addressPending?: unknown; influencer?: { street?: unknown; cityProvPostal?: unknown } }
  const marked = Array.isArray(p.addressPending) ? (p.addressPending as string[]) : null
  const printed =
    String(p.influencer?.street ?? '').trim() === STREET_PLACEHOLDER ||
    String(p.influencer?.cityProvPostal ?? '').trim() === CITY_LINE_PLACEHOLDER
  if (!marked && !printed) return null
  const fields = (marked ?? []).filter((f): f is AddressField => (ADDRESS_FIELDS as readonly string[]).includes(f))
  const list = (fields.length ? fields : [...ADDRESS_FIELDS]).map(f => LABEL[f]).join(', ')
  return `No mailing address on file (missing ${list}). Fill it in on the roster, then send.`
}
