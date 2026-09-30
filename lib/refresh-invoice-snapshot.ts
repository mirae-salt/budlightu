/**
 * Push a corrected roster record into the invoices that were built from it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `generateInvoicePayload` copies the BAM's name, address, email, phone and banking
 * into `invoices.payload_json` once, at creation. After that the invoice is a
 * snapshot and nothing re-read the roster. Two real corrections on 2026-09-17 showed
 * what that costs:
 *
 *   Emma Thompson  asked for her mailing address to be fixed. An admin can fix it on
 *                  /admin/roster, and that edit reached `bams` and stopped there. The
 *                  invoice, the PDF and AP all kept the old city and postal code.
 *   Lauren Burnett asked for an extra digit to come out of her account number. The
 *                  banking approval path DID swap `payload_json.directDeposit`, but it
 *                  left `pdf_key` alone, and `ensureInvoicePdf` returns the stored
 *                  bytes whenever `pdf_key` is set. So the portal, the admin preview
 *                  and the ZIP all rendered the corrected number from the payload
 *                  while the AP email carried a PDF of the old one. The screen used to
 *                  check the work and the document that actually leaves disagreed, which
 *                  is not a difference anyone catches by looking.
 *
 * So both halves are required and neither is optional: rewrite the payload AND drop
 * `pdf_key` so the next render is a real render.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It never touches money. Lines, subtotal, tax and total are left exactly as they are.
 * A province change does move the tax, so that case is reported back as a note telling
 * the admin to void and reissue rather than being recomputed quietly here. Recomputing
 * a total as a side effect of an address edit is the kind of thing nobody looks for
 * afterwards.
 *
 * It only touches invoices that have not gone out (`draft`, `approved`). A `sent`
 * invoice is a record of what AP received and must keep saying so.
 */
import type { InvoicePayload } from './invoice-payload'
import { STREET_PLACEHOLDER, CITY_LINE_PLACEHOLDER } from './invoice-address-placeholder'

/** The roster facts an invoice snapshot carries. All optional: pass what changed. */
export type SnapshotPatch = {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
  street?: string | null
  city?: string | null
  prov?: string | null
  postal?: string | null
  bankName?: string | null
  institutionNo?: string | null
  transitNo?: string | null
  accountNo?: string | null
}

export type MergeResult = {
  /** The payload to store, or null when nothing in it would change. */
  next: Record<string, unknown> | null
  /** Human-readable list of what moved, for the caller's response and the audit entry. */
  changed: string[]
  /**
   * Set when the edit changes something this function refuses to recompute.
   * Today that is only the province, which drives the HST line.
   */
  warning?: string
}

const str = (v: unknown): string => String(v ?? '').trim()

/**
 * Whitespace-insensitive comparison, used ONLY to decide whether something changed.
 *
 * Real case: a roster row holds the city as "Thornhill " with a trailing space, and the
 * payload baked that in, so rebuilding the line produced "Thornhill, ON, L3T 3K8" against
 * a stored "Thornhill , ON, L3T 3K8". Nothing had changed and nobody could see a
 * difference, but a strict comparison called it drift and painted a live September
 * invoice red. A badge that cries wolf over an invisible character stops being read,
 * which costs more than the whitespace does.
 *
 * The cleaned value is still what gets written when something genuinely moves. This
 * only governs whether a write happens at all.
 */
const same = (a: unknown, b: unknown): boolean =>
  String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim()

/**
 * PURE. Merge a roster patch into one stored payload.
 *
 * Returns `next: null` when the stored values already match, so a caller editing a
 * phone number does not rewrite (and un-archive the PDF of) every open invoice.
 */
export function mergeInvoiceSnapshot(
  payload: Record<string, unknown> | null | undefined,
  patch: SnapshotPatch
): MergeResult {
  const changed: string[] = []
  if (!payload || typeof payload !== 'object') {
    return { next: null, changed }
  }

  const p = payload as unknown as InvoicePayload
  const influencer = { ...(p.influencer ?? {}) } as Record<string, unknown>
  const directDeposit = { ...(p.directDeposit ?? {}) } as Record<string, unknown>

  // Name: shown in the header AND on the "make cheques payable to" line. Both are
  // built from the same two roster columns, so both move together or the document
  // contradicts itself.
  const first = patch.firstName === undefined ? null : str(patch.firstName)
  const last = patch.lastName === undefined ? null : str(patch.lastName)
  let nextName: string | null = null
  if (first !== null || last !== null) {
    const currentName = str(influencer.name)
    const [curFirst, ...curRest] = currentName.split(' ')
    const composed = `${first ?? curFirst ?? ''} ${last ?? curRest.join(' ')}`.trim()
    if (composed && !same(composed, currentName)) nextName = composed
  }
  if (nextName) {
    influencer.name = nextName
    changed.push('name')
  }

  if (patch.email !== undefined && str(patch.email) && !same(patch.email, influencer.email)) {
    influencer.email = str(patch.email)
    changed.push('email')
  }
  if (patch.phone !== undefined && !same(patch.phone, influencer.phone)) {
    influencer.phone = str(patch.phone)
    changed.push('phone')
  }
  if (patch.street !== undefined && str(patch.street) && !same(patch.street, influencer.street)) {
    influencer.street = str(patch.street)
    changed.push('street')
  }

  // City, province and postal code render as one line, so a change to any of the
  // three has to rebuild it from all three. Reading the missing parts back out of
  // the stored string would reintroduce a parser nobody needs; the caller passes
  // whichever of the three it did not change.
  if (patch.city !== undefined || patch.prov !== undefined || patch.postal !== undefined) {
    // A placeholder line is not an address to keep parts of.
    const current = str(influencer.cityProvPostal) === CITY_LINE_PLACEHOLDER ? '' : str(influencer.cityProvPostal)
    const [curCity = '', curProv = '', curPostal = ''] = current.split(',').map(s => s.trim())
    const city = patch.city === undefined ? curCity : str(patch.city)
    const prov = patch.prov === undefined ? curProv : str(patch.prov)
    const postal = patch.postal === undefined ? curPostal : str(patch.postal)
    const composed = `${city}, ${prov}, ${postal}`
    // Compared part by part, not as one joined string. Collapsing runs of whitespace
    // does not remove the space in "Thornhill , ON", so comparing the joined strings
    // still called an untouched invoice out of date.
    const moved = !same(city, curCity) || !same(prov, curProv) || !same(postal, curPostal)
    if (city && prov && postal && moved) {
      influencer.cityProvPostal = composed
      changed.push('mailing address')
    }
  }

  const dd: Array<[keyof SnapshotPatch, string, string]> = [
    ['bankName', 'bank', 'bank name'],
    ['institutionNo', 'institutionNumber', 'institution number'],
    ['transitNo', 'transitNumber', 'transit number'],
    ['accountNo', 'accountNumber', 'account number']
  ]
  for (const [patchKey, payloadKey, label] of dd) {
    const value = patch[patchKey]
    if (value === undefined) continue
    // Strings all the way: a transit number coerced through a number loses its
    // leading zero, and that is a payment sent somewhere else.
    const clean = str(value)
    if (!clean || same(clean, directDeposit[payloadKey])) continue
    directDeposit[payloadKey] = clean
    changed.push(label)
  }
  if (patch.email !== undefined && str(patch.email) && !same(patch.email, directDeposit.email)) {
    directDeposit.email = str(patch.email)
    if (!changed.includes('email')) changed.push('email')
  }

  if (changed.length === 0) return { next: null, changed }

  const next: Record<string, unknown> = { ...payload, influencer, directDeposit }
  // The draft was built without an address. Once both lines are real, it may be sent.
  if (Array.isArray((payload as { addressPending?: unknown }).addressPending)) {
    const stillPlaceholder =
      str(influencer.street) === STREET_PLACEHOLDER || str(influencer.cityProvPostal) === CITY_LINE_PLACEHOLDER
    if (!stillPlaceholder) {
      delete next.addressPending
      changed.push('address no longer missing')
    }
  }
  if (nextName) next.makeChecksTo = nextName

  // The province drives computeHst. Moving it silently would leave a document whose
  // tax line belongs to the province the BAM used to live in, and the arithmetic
  // would still add up, so nothing downstream would flag it.
  const provMoved = changed.includes('mailing address')
    && patch.prov !== undefined
    && !same(patch.prov, str(p.influencer?.cityProvPostal).split(',')[1])
  const warning = provMoved
    ? 'The province changed, which changes the HST on this invoice. The tax line was NOT recalculated — void and reissue this invoice if the tax is wrong.'
    : undefined

  return { next, changed, ...(warning ? { warning } : {}) }
}

/** The roster columns a drift check compares. Banking is deliberately absent — see below. */
export type RosterFacts = {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  street?: string | null
  city?: string | null
  prov?: string | null
  postal?: string | null
}

/**
 * PURE. Which fields on this invoice no longer agree with the roster.
 *
 * WHY A PULL EXISTS WHEN THERE IS ALREADY A PUSH
 * ----------------------------------------------
 * refreshOpenInvoices runs from the two screens that edit a BAM today. That covers
 * what people actually do and it does not cover everything: onboarding ingest, a CSV
 * import, a fix- script and a hand edit in the Supabase dashboard all write `bams`
 * without going near it, and a push that silently missed one leaves no trace. This
 * compares the two sides after the fact, so an invoice that drifted for ANY reason
 * says so instead of waiting to be noticed on a PDF.
 *
 * BANKING IS NOT CHECKED HERE, ON PURPOSE
 * ---------------------------------------
 * The stored numbers are encrypted and reading them costs one RPC per BAM, which on a
 * 55-row list is 55 decrypts of other people's account numbers to render a badge.
 * Banking drift is already fail-closed where it counts: batch-approve re-decrypts and
 * refuses to send any invoice whose payload disagrees with the BAM's current banking.
 * This function covers the fields that have no such gate.
 */
export function rosterDrift(
  payload: Record<string, unknown> | null | undefined,
  roster: RosterFacts
): string[] {
  const merged = mergeInvoiceSnapshot(payload, {
    firstName: roster.first_name,
    lastName: roster.last_name,
    email: roster.email,
    phone: roster.phone,
    street: roster.street,
    city: roster.city,
    prov: roster.prov,
    postal: roster.postal
  })
  // "Nothing to write" and "nothing has drifted" are the same question asked twice,
  // so the comparison lives in one place rather than two that can disagree.
  return merged.changed
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (...args: any[]) => any }

export type RefreshResult = {
  /** One line per invoice, suitable for showing the admin who made the edit. */
  notes: string[]
  /** true when every open invoice that needed a rewrite got one. */
  ok: boolean
}

/**
 * Apply `patch` to every not-yet-sent invoice for one BAM.
 *
 * Never throws and never fails the caller's own write. The roster edit or the banking
 * approval has already happened and is already audited by the time this runs; this
 * keeps the documents consistent with it and reports honestly when it could not.
 */
export async function refreshOpenInvoices(
  db: Db,
  bamId: string,
  patch: SnapshotPatch,
  /** Restrict to one invoice. Used by the per-invoice "Sync with roster" action. */
  onlyInvoiceId?: string
): Promise<RefreshResult> {
  const notes: string[] = []
  let ok = true

  let q = db.from('invoices')
    .select('id, period, status, payload_json')
    .eq('bam_id', bamId)
    .in('status', ['draft', 'approved'])
  if (onlyInvoiceId) q = q.eq('id', onlyInvoiceId)
  const { data, error } = await q
  if (error) {
    return {
      ok: false,
      notes: [`Could not check this BAM's open invoices (${error.message}). Open /admin/invoices and confirm them by hand.`]
    }
  }

  const rows = (data ?? []) as Array<{
    id: string; period: string; status: string; payload_json: Record<string, unknown> | null
  }>

  for (const inv of rows) {
    const merged = mergeInvoiceSnapshot(inv.payload_json, patch)
    if (!merged.next) continue

    // `pdf_key: null` is the half that matters most. Without it ensureInvoicePdf
    // hands AP the bytes rendered before this correction.
    const { data: saved, error: upErr } = await db.from('invoices')
      .update({ payload_json: merged.next, pdf_key: null })
      .eq('id', inv.id)
      .eq('status', inv.status)
      .select('id, pdf_key')
    if (upErr || !(saved ?? []).length) {
      ok = false
      notes.push(
        `${inv.period} invoice (${inv.status}) still shows the OLD ${merged.changed.join(', ')} — ` +
        `it could not be updated (${upErr?.message ?? 'no row matched'}). Do not send it until this is fixed.`
      )
      continue
    }
    if (saved[0].pdf_key !== null) {
      // Read-back, not "the update returned no error". A stored PDF surviving this
      // is the exact failure the whole function exists to prevent.
      ok = false
      notes.push(
        `${inv.period} invoice (${inv.status}) was updated but its archived PDF was not cleared. ` +
        'AP would receive the old document. Tell your developer before sending.'
      )
      continue
    }
    notes.push(
      `${inv.period} invoice (${inv.status}) updated: ${merged.changed.join(', ')}.` +
      (merged.warning ? ` ${merged.warning}` : '')
    )
  }

  return { ok, notes }
}
