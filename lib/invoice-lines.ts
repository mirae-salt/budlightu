/**
 * In-app editing of invoice lines (salary + ad-hoc only).
 *
 * WHY THIS SPLIT EXISTS
 * ---------------------
 * Amount corrections have two different homes, decided by where the number comes
 * from:
 *
 *   reimbursement  -> corrected on the RECEIPT (/admin/receipts, override_total).
 *                     It flows receipt -> reimbursement_ledger.paid_cad -> invoice.
 *   salary/ad-hoc  -> corrected HERE. Neither is automated: ad-hoc items (bar tab,
 *                     gas, event costs) are Robin's manual adjustments, and the
 *                     salary line is a flat cohort figure that occasionally needs a
 *                     one-off correction.
 *
 * WHY EDITING THE OTHER LINES IS SAFE
 * -----------------------------------
 * `payloadLedgerMismatch` (lib/invoice-ledger.ts) is the last line of defence
 * before an AP send: it HARD BLOCKS when the invoice disagrees with the ledger.
 * It compares ONLY lines whose description matches /reimbursement/i against
 * `reimbursement_ledger.paid_cad` — see `reimbursementLineTotal`, which sums
 * exactly those lines and nothing else. So a salary or ad-hoc line is outside
 * that check by construction and editing it cannot weaken it.
 *
 * The reimbursement line, by contrast, IS that check's subject. Editing it here
 * would either (a) desynchronise invoice and ledger, which the send-time block
 * then turns into a stuck invoice nobody can explain, or (b) tempt someone to
 * relax the block. So it is refused, and the refusal names /admin/receipts.
 *
 * DESIGN NOTES
 * ------------
 * Everything except `applyInvoiceLineEdit` is pure and unit tested without a
 * database. `applyInvoiceLineEdit` takes the client, so it is reusable from a
 * route handler today and from an Edge Function after a stack change.
 *
 * Totals are ALWAYS recomputed server-side from the submitted lines with the same
 * helpers the generator uses (`computeHst`, `round2`). A client-sent subtotal /
 * tax / total is read by nothing in this file.
 */
import { cleanText } from './sanitize'
import { round2, parseMoney } from './money'
import { computeHst } from './invoice-payload'
import { reimbursementLineTotal, type PayloadLineish } from './invoice-ledger'
import { assertPdfRenderable } from './pdf-text'
import { INVOICE_PDF_BUCKET } from './invoice-pdf'

/**
 * Only these two statuses are editable.
 *
 * 'sent' and 'paid': AP already holds the document, so changing the numbers
 * underneath it would make our record disagree with theirs silently. Void and
 * reissue instead — that path already generates an AP cancellation draft
 * (0007_void_ap_cancellation.sql).
 * 'void': there is nothing to correct.
 *
 * 'approved' is editable because batch-approve reaches 'approved' only when the
 * AP step did NOT complete a live send (a live send sets 'sent'), so nothing has
 * left the building yet.
 */
export const EDITABLE_STATUSES = ['draft', 'approved'] as const
export type EditableStatus = (typeof EDITABLE_STATUSES)[number]

/** Guard rails so a typo cannot produce a five-figure invoice. */
export const MAX_LINES = 12
export const MIN_DESCRIPTION_LEN = 3
export const MAX_DESCRIPTION_LEN = 120
export const MAX_QTY = 99
/** Per line. Salary is ~$250 and reimbursement is capped at $150; ad-hoc event
 *  costs are the only reason this is not tighter. */
export const MAX_LINE_TOTAL = 2000
/** Per invoice, tax included. */
export const MAX_INVOICE_TOTAL = 5000
export const REASON_MIN = 5
export const REASON_MAX = 500

export type InvoiceLine = { qty: number; description: string; unitPrice: number; total: number }

export type Failed = { ok: false; status: number; message: string }
const fail = (status: number, message: string): Failed => ({ ok: false, status, message })

/**
 * Same predicate `reimbursementLineTotal` uses, kept as one named function so
 * the two can be asserted equivalent in tests. Do not "improve" the regex here
 * without changing lib/invoice-ledger.ts in the same commit: the send-time hard
 * block depends on both agreeing about which line is the reimbursement.
 */
export function isReimbursementLine(line: PayloadLineish | InvoiceLine): boolean {
  return typeof line?.description === 'string' && /reimbursement/i.test(line.description)
}

// ── line parsing / validation ────────────────────────────────────────────────

/**
 * Quantity: a whole count of things. Form inputs arrive as strings.
 * NOT parsed with parseMoney: "1.5 monthly payments" is a data-entry error, not
 * a quantity, and rounding it silently would change the amount.
 */
function parseQty(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof raw !== 'number' && typeof raw !== 'string') return { ok: false, error: 'quantity is required' }
  const text = typeof raw === 'string' ? cleanText(raw) : String(raw)
  if (!/^\d{1,3}$/.test(text)) return { ok: false, error: 'quantity must be a whole number' }
  const value = Number(text)
  if (!Number.isFinite(value) || value < 1) return { ok: false, error: 'quantity must be at least 1' }
  if (value > MAX_QTY) return { ok: false, error: `quantity cannot be more than ${MAX_QTY}` }
  return { ok: true, value }
}

/**
 * Parse + sanitize the submitted lines.
 *
 * `total` is always recomputed as qty * unitPrice. A client-sent total is never
 * trusted, not even as a cross-check that could be argued into a fallback.
 * Descriptions go through `cleanText` because they end up in a PDF and in an
 * email to AP, and an invisible character in either is the incident class this
 * project already had (ENGINEERING-RULES section 7.6).
 */
export function parseInvoiceLines(raw: unknown): { ok: true; lines: InvoiceLine[] } | Failed {
  if (!Array.isArray(raw)) return fail(400, 'lines must be an array of line items.')
  if (raw.length === 0) return fail(400, 'An invoice needs at least one line.')
  if (raw.length > MAX_LINES) return fail(400, `An invoice cannot have more than ${MAX_LINES} lines.`)

  const lines: InvoiceLine[] = []
  for (let i = 0; i < raw.length; i++) {
    const n = i + 1
    const src = raw[i]
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      return fail(400, `Line ${n} is not a line item.`)
    }
    const row = src as Record<string, unknown>

    const description = cleanText(row.description)
    if (!description) return fail(400, `Line ${n} needs a description.`)
    if (description.length < MIN_DESCRIPTION_LEN) {
      return fail(400, `Line ${n}: the description is too short to be meaningful on an invoice.`)
    }
    if (description.length > MAX_DESCRIPTION_LEN) {
      return fail(400, `Line ${n}: the description cannot be longer than ${MAX_DESCRIPTION_LEN} characters.`)
    }

    const qty = parseQty(row.qty)
    if (!qty.ok) return fail(400, `Line ${n}: ${qty.error}.`)

    const unitPrice = parseMoney(row.unitPrice)
    if (unitPrice === null) return fail(400, `Line ${n}: the unit price is not a usable amount.`)
    if (unitPrice < 0) return fail(400, `Line ${n}: the unit price cannot be negative. Void and reissue instead of invoicing a credit.`)
    if (unitPrice > MAX_LINE_TOTAL) {
      return fail(400, `Line ${n}: $${unitPrice.toFixed(2)} is over the $${MAX_LINE_TOTAL.toFixed(2)} per line limit. Check the value.`)
    }

    const total = round2(qty.value * unitPrice)
    if (!Number.isFinite(total)) return fail(400, `Line ${n}: the line total is not a usable amount.`)
    if (total > MAX_LINE_TOTAL) {
      return fail(400, `Line ${n}: $${total.toFixed(2)} is over the $${MAX_LINE_TOTAL.toFixed(2)} per line limit. Check the quantity and unit price.`)
    }

    lines.push({ qty: qty.value, description, unitPrice, total })
  }
  return { ok: true, lines }
}

// ── totals ───────────────────────────────────────────────────────────────────

export type TaxContext = {
  /** true only when the BAM has an HST number on file, mirroring generateInvoicePayload. */
  hstApplicable: boolean
  /** Province code used for the rate. Ignored when hstApplicable is false. */
  province: string
}

export type Totals = { subtotal: number; tax: number; total: number }

/**
 * Mirrors generateInvoicePayload exactly:
 *   subtotal = round2(sum of line totals)
 *   tax      = bam.hstNumber ? computeHst(subtotal, bam.prov) : 0
 *   total    = round2(subtotal + tax)
 *
 * Including the deliberate decision recorded there that tax applies to the whole
 * subtotal. Whether the reimbursement pass-through should be taxable is a finance
 * decision (AUDIT-2026-08-07 P1-10) and this editor is not the place to change it.
 */
export function recomputeTotals(lines: InvoiceLine[], ctx: TaxContext): { ok: true } & Totals | Failed {
  const subtotal = round2(lines.reduce((sum, l) => sum + l.total, 0))
  if (!Number.isFinite(subtotal)) return fail(400, 'The subtotal is not a usable amount.')

  let tax = 0
  if (ctx.hstApplicable) {
    try {
      tax = computeHst(subtotal, ctx.province)
    } catch (e) {
      return fail(409, e instanceof Error ? e.message : String(e))
    }
  }

  const total = round2(subtotal + tax)
  if (total > MAX_INVOICE_TOTAL) {
    return fail(
      400,
      `The invoice total would be $${total.toFixed(2)}, over the $${MAX_INVOICE_TOTAL.toFixed(2)} limit for a single invoice. ` +
      `Check the amounts. If this is genuinely correct it needs Robin and Nathan, not an edit here.`
    )
  }
  return { ok: true, subtotal, tax, total }
}

// ── the reimbursement line is off limits ─────────────────────────────────────

const RECEIPT_QUEUE_HINT =
  'The reimbursement amount comes from the receipt, not the invoice. Change it on /admin/receipts ' +
  '(override the receipt total), which updates the reimbursement ledger, then regenerate the invoice.'

/**
 * Returns an error string when the submitted lines touch the reimbursement line
 * in any way, or null when they leave it exactly as it was.
 *
 * Stricter than the ledger check on purpose: the ledger check only looks at the
 * summed total, so renaming "Reimbursement for sponsorship allowance (July)" to
 * "(August)" would pass it while changing what AP reads. Here the reimbursement
 * line must come back byte-identical (after the same sanitizing every line gets).
 */
export function reimbursementEditProblem(
  before: PayloadLineish[] | null | undefined,
  after: InvoiceLine[]
): string | null {
  const beforeR = (before ?? []).filter(isReimbursementLine)
  const afterR = after.filter(isReimbursementLine)

  if (afterR.length > 1) {
    return `An invoice can carry only one reimbursement line. ${RECEIPT_QUEUE_HINT}`
  }
  if (afterR.length > beforeR.length) {
    return `A reimbursement line cannot be added on the invoice. ${RECEIPT_QUEUE_HINT}`
  }
  if (afterR.length < beforeR.length) {
    return `The reimbursement line cannot be removed on the invoice. ${RECEIPT_QUEUE_HINT}`
  }

  const beforeTotal = reimbursementLineTotal(before)
  const afterTotal = reimbursementLineTotal(after)
  if (beforeTotal !== afterTotal) {
    return (
      `The reimbursement line cannot be changed here ($${beforeTotal.toFixed(2)} to $${afterTotal.toFixed(2)}). ` +
      RECEIPT_QUEUE_HINT
    )
  }

  for (let i = 0; i < beforeR.length; i++) {
    const b = beforeR[i]
    const a = afterR[i]
    const bDesc = cleanText(b.description)
    const bQty = Number((b as { qty?: unknown }).qty ?? 1)
    const bUnit = parseMoney((b as { unitPrice?: unknown }).unitPrice) ?? round2(Number(b.total ?? 0))
    if (a.description !== bDesc || a.qty !== bQty || a.unitPrice !== bUnit) {
      return `The reimbursement line is read-only on the invoice. ${RECEIPT_QUEUE_HINT}`
    }
  }
  return null
}

// ── reason ───────────────────────────────────────────────────────────────────

export function parseEditReason(raw: unknown): { ok: true; reason: string } | Failed {
  if (typeof raw !== 'string') return fail(400, 'A reason is required for an amount change.')
  const reason = cleanText(raw)
  if (reason.length < REASON_MIN) {
    return fail(400, `Please say why the amounts are changing (at least ${REASON_MIN} characters). This is a money change and it is logged.`)
  }
  if (reason.length > REASON_MAX) return fail(400, `The reason cannot be longer than ${REASON_MAX} characters.`)
  return { ok: true, reason }
}

// ── HST applicability ────────────────────────────────────────────────────────

/**
 * Decides whether tax applies, WITHOUT decrypting anything.
 *
 * `bams.hst_number` holds ciphertext (0003_encryption_pgsodium.sql) and the
 * plaintext is reachable only through `decrypt_bam_banking`. This editor never
 * calls it: an edit does not need the number, only whether one exists, so the
 * caller passes `hstOnFile` (derived from a `hst_number is not null` filter, so
 * the ciphertext is never even fetched).
 *
 * `taxOnInvoice` is what the generator actually decided when this invoice was
 * created. If the two disagree the BAM's HST status changed after generation, and
 * an edit is the wrong moment to silently start or stop charging tax, so it is
 * refused with an explanation. Fail closed (ENGINEERING-RULES 7.5).
 */
export function resolveHstApplicable(input: {
  hstOnFile: boolean
  storedSubtotal: number
  storedTax: number
}): { ok: true; hstApplicable: boolean } | Failed {
  const { hstOnFile, storedSubtotal, storedTax } = input
  const taxOnInvoice = Number.isFinite(storedTax) && storedTax > 0

  // A zero subtotal carries no signal either way (the generator would have
  // produced tax 0 regardless), so trust the roster.
  if (!(Number.isFinite(storedSubtotal) && storedSubtotal > 0)) {
    return { ok: true, hstApplicable: hstOnFile }
  }

  if (hstOnFile !== taxOnInvoice) {
    return fail(
      409,
      hstOnFile
        ? 'This invoice was generated with no HST, but the BAM now has an HST number on file. ' +
          'Editing lines here would start charging tax as a side effect. Void and reissue the invoice instead.'
        : 'This invoice charges HST, but the BAM no longer has an HST number on file. ' +
          'Editing lines here would drop the tax as a side effect. Void and reissue the invoice instead.'
    )
  }
  return { ok: true, hstApplicable: hstOnFile }
}

// ── the write path ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LineEditDbClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (...args: any[]) => any
  storage?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: (bucket: string) => any
  }
}

export type LineEditActor = { userId: string | null; role: string }

export type LineEditSuccess = {
  ok: true
  invoiceId: string
  invoiceNumber: string
  status: string
  lines: InvoiceLine[]
  subtotal: number
  tax: number
  total: number
  /** true when invoices.pdf_key was cleared so the next send re-renders. */
  pdfInvalidated: boolean
  /** Non-fatal problems the admin still has to know about. */
  warnings: string[]
}

export type LineEditResult = LineEditSuccess | Failed

type StoredPayload = {
  lines?: PayloadLineish[]
  subtotal?: unknown
  tax?: unknown
  total?: unknown
}

/**
 * Edit the lines of one invoice.
 *
 * Order of operations matters and is deliberate:
 *   1. read the invoice (status, payload, pdf_key)
 *   2. refuse a non-editable status
 *   3. parse + sanitize the submitted lines
 *   4. refuse any change to the reimbursement line
 *   5. recompute subtotal/tax/total server-side
 *   6. assertPdfRenderable BEFORE saving, so an unprintable character is rejected
 *      at edit time instead of blocking the send later
 *   7. write payload_json AND clear pdf_key in the same UPDATE, guarded on the
 *      status we read, then read the row back and compare
 *   8. delete the stale stored PDF object (best effort; pdf_key is what actually
 *      gates reuse in ensureInvoicePdf)
 *   9. audit_log
 */
export async function applyInvoiceLineEdit(
  db: LineEditDbClient,
  input: {
    invoiceId: string
    lines: unknown
    reason: unknown
    actor: LineEditActor
    /** `bams.hst_number is not null`. Resolved by the caller; never the value itself. */
    hstOnFile: boolean
    /** `bams.prov`, used only for the tax rate. */
    province: string
  }
): Promise<LineEditResult> {
  const { invoiceId, actor } = input

  if (typeof invoiceId !== 'string' || !invoiceId) return fail(400, 'invoice id is required.')

  const parsedReason = parseEditReason(input.reason)
  if (!parsedReason.ok) return parsedReason

  // ── 1. read ────────────────────────────────────────────────────────────────
  const { data: rows, error: readErr } = await db
    .from('invoices')
    .select('id, invoice_number, status, period, payload_json, pdf_key')
    .eq('id', invoiceId)
  if (readErr) return fail(500, `Could not read the invoice: ${readErr.message}`)

  const invoice = (rows ?? [])[0] as
    | { id: string; invoice_number: string; status: string; period: string; payload_json: unknown; pdf_key: string | null }
    | undefined
  if (!invoice) return fail(404, 'That invoice does not exist. Reload the page.')

  // Captured BEFORE the update. Reading it afterwards is how you end up asking a
  // row that has already been cleared which object to delete, and silently
  // leaving the stale PDF in the bucket.
  const previousPdfKey = invoice.pdf_key ?? null

  // ── 2. status ──────────────────────────────────────────────────────────────
  if (!(EDITABLE_STATUSES as readonly string[]).includes(invoice.status)) {
    return fail(
      409,
      invoice.status === 'void'
        ? `${invoice.invoice_number} is void. There is nothing to correct on it. Regenerate the month instead.`
        : `${invoice.invoice_number} is ${invoice.status}, so AP already holds this document. ` +
          'Void it and reissue rather than changing the amounts underneath them.'
    )
  }

  const payload = invoice.payload_json
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail(409, `${invoice.invoice_number} has no usable payload. Regenerate it before editing.`)
  }
  const stored = payload as StoredPayload
  if (!Array.isArray(stored.lines)) {
    return fail(409, `${invoice.invoice_number} has no line items stored. Regenerate it before editing.`)
  }
  const beforeLines = stored.lines

  // ── 3. lines ───────────────────────────────────────────────────────────────
  const parsedLines = parseInvoiceLines(input.lines)
  if (!parsedLines.ok) return parsedLines
  const afterLines = parsedLines.lines

  // ── 4. reimbursement is off limits ─────────────────────────────────────────
  const reimbProblem = reimbursementEditProblem(beforeLines, afterLines)
  if (reimbProblem) return fail(409, reimbProblem)

  // ── 5. totals, server-side only ────────────────────────────────────────────
  const hst = resolveHstApplicable({
    hstOnFile: input.hstOnFile,
    storedSubtotal: Number(stored.subtotal ?? 0),
    storedTax: Number(stored.tax ?? 0)
  })
  if (!hst.ok) return hst

  const totals = recomputeTotals(afterLines, { hstApplicable: hst.hstApplicable, province: input.province })
  if (!totals.ok) return totals

  const newPayload = {
    ...(payload as Record<string, unknown>),
    lines: afterLines,
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total
  }

  // ── 6. would this still print? (P1-9) ──────────────────────────────────────
  try {
    assertPdfRenderable(newPayload)
  } catch (e) {
    return fail(400, e instanceof Error ? e.message : String(e))
  }

  // ── 7. write + read back ───────────────────────────────────────────────────
  // pdf_key is cleared in the SAME update. ensureInvoicePdf returns the stored
  // object whenever pdf_key is set, so leaving it would attach the pre-edit PDF
  // to the AP email: the numbers in the database would be right and the document
  // AP pays from would be wrong. This is the one detail that cannot be skipped.
  //
  // The status guard makes this a compare-and-set: if a send or a void landed
  // between the read and the write, 0 rows match and the admin is told.
  const { data: updated, error: updErr } = await db
    .from('invoices')
    .update({ payload_json: newPayload, pdf_key: null })
    .eq('id', invoiceId)
    .eq('status', invoice.status)
    .select('id, status, payload_json, pdf_key')
  if (updErr) return fail(500, `The edit was NOT saved: ${updErr.message}`)

  const savedRow = (updated ?? [])[0] as
    | { id: string; status: string; payload_json: unknown; pdf_key: string | null }
    | undefined
  if (!savedRow) {
    return fail(
      409,
      `${invoice.invoice_number} changed while it was being edited (it is no longer ${invoice.status}). ` +
      'Nothing was saved. Reload and check its status before trying again.'
    )
  }

  const savedPayload = (savedRow.payload_json ?? {}) as StoredPayload
  const savedTotal = Number(savedPayload.total)
  if (!Number.isFinite(savedTotal) || round2(savedTotal) !== totals.total) {
    return fail(
      500,
      `The invoice was written but the stored total read back as ${JSON.stringify(savedPayload.total)} ` +
      `instead of ${totals.total.toFixed(2)}. Do NOT send this invoice. Tell Mirae.`
    )
  }

  const warnings: string[] = []
  if (savedRow.pdf_key) {
    // Should be impossible (service_role is exempt from the system-field guard),
    // but if pdf_key survived, the next send would attach the old document.
    warnings.push(
      'The stored PDF reference could not be cleared, so a send could still attach the old document. ' +
      'Do not send this invoice until that is fixed.'
    )
  }

  // ── 8. drop the stale object (best effort) ─────────────────────────────────
  let pdfObjectRemoved = false
  if (previousPdfKey && db.storage) {
    const { error: rmErr } = await db.storage.from(INVOICE_PDF_BUCKET).remove([previousPdfKey])
    if (rmErr) {
      warnings.push(
        `The previously rendered PDF (${previousPdfKey}) could not be deleted from storage: ${rmErr.message}. ` +
        'It will be overwritten on the next render, and pdf_key is already cleared, so no send will use it.'
      )
    } else {
      pdfObjectRemoved = true
    }
  }

  if (invoice.status === 'approved') {
    warnings.push(
      'This invoice had already been through batch approval, so an archived copy or a draft email may hold the old amounts. ' +
      'Re-run the approval so every copy matches.'
    )
  }

  // ── 9. audit ───────────────────────────────────────────────────────────────
  // Column shape is exactly: actor_id, actor_role, entity, entity_id, action,
  // before_json, after_json. There is no `meta` column; an extra key makes the
  // insert fail, and the failure is reported rather than swallowed.
  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: actor.userId,
    actor_role: actor.role,
    entity: 'invoices',
    entity_id: invoiceId,
    action: 'invoice_lines_edit',
    before_json: {
      lines: beforeLines,
      subtotal: stored.subtotal ?? null,
      tax: stored.tax ?? null,
      total: stored.total ?? null,
      pdf_key: previousPdfKey,
      status: invoice.status
    },
    after_json: {
      reason: parsedReason.reason,
      lines: afterLines,
      subtotal: totals.subtotal,
      tax: totals.tax,
      total: totals.total,
      pdf_key: null,
      pdf_object_removed: pdfObjectRemoved,
      hst_applied: hst.hstApplicable
    }
  })
  if (auditErr) {
    warnings.push(`The change was saved but the audit log entry failed: ${auditErr.message}. Tell Mirae.`)
  }

  return {
    ok: true,
    invoiceId,
    invoiceNumber: invoice.invoice_number,
    status: savedRow.status,
    lines: afterLines,
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    pdfInvalidated: !savedRow.pdf_key,
    warnings
  }
}
