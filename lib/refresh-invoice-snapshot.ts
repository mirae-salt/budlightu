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
    if (composed && composed !== currentName) nextName = composed
  }
  if (nextName) {
    influencer.name = nextName
    changed.push('name')
  }

  if (patch.email !== undefined && str(patch.email) && str(patch.email) !== str(influencer.email)) {
    influencer.email = str(patch.email)
    changed.push('email')
  }
  if (patch.phone !== undefined && str(patch.phone) !== str(influencer.phone)) {
    influencer.phone = str(patch.phone)
    changed.push('phone')
  }
  if (patch.street !== undefined && str(patch.street) && str(patch.street) !== str(influencer.street)) {
    influencer.street = str(patch.street)
    changed.push('street')
  }

  // City, province and postal code render as one line, so a change to any of the
  // three has to rebuild it from all three. Reading the missing parts back out of
  // the stored string would reintroduce a parser nobody needs; the caller passes
  // whichever of the three it did not change.
  if (patch.city !== undefined || patch.prov !== undefined || patch.postal !== undefined) {
    const current = str(influencer.cityProvPostal)
    const [curCity = '', curProv = '', curPostal = ''] = current.split(',').map(s => s.trim())
    const city = patch.city === undefined ? curCity : str(patch.city)
    const prov = patch.prov === undefined ? curProv : str(patch.prov)
    const postal = patch.postal === undefined ? curPostal : str(patch.postal)
    const composed = `${city}, ${prov}, ${postal}`
    if (city && prov && postal && composed !== current) {
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
    if (!clean || clean === str(directDeposit[payloadKey])) continue
    directDeposit[payloadKey] = clean
    changed.push(label)
  }
  if (patch.email !== undefined && str(patch.email) && str(patch.email) !== str(directDeposit.email)) {
    directDeposit.email = str(patch.email)
    if (!changed.includes('email')) changed.push('email')
  }

  if (changed.length === 0) return { next: null, changed }

  const next: Record<string, unknown> = { ...payload, influencer, directDeposit }
  if (nextName) next.makeChecksTo = nextName

  // The province drives computeHst. Moving it silently would leave a document whose
  // tax line belongs to the province the BAM used to live in, and the arithmetic
  // would still add up, so nothing downstream would flag it.
  const provMoved = changed.includes('mailing address')
    && patch.prov !== undefined
    && str(patch.prov) !== str(str(p.influencer?.cityProvPostal).split(',')[1])
  const warning = provMoved
    ? 'The province changed, which changes the HST on this invoice. The tax line was NOT recalculated — void and reissue this invoice if the tax is wrong.'
    : undefined

  return { next, changed, ...(warning ? { warning } : {}) }
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
  patch: SnapshotPatch
): Promise<RefreshResult> {
  const notes: string[] = []
  let ok = true

  const { data, error } = await db.from('invoices')
    .select('id, period, status, payload_json')
    .eq('bam_id', bamId)
    .in('status', ['draft', 'approved'])
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
