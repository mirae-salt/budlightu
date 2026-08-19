/**
 * Touchpoint 1, second half: correcting WHICH lines are Bud Light.
 *
 * The review queue showed a `BL?` tick per line and a computed Bud Light total,
 * and Robin's only actions were APPROVE and REJECT. If the model ticked
 * `CHIPS LAYS SEL`, or missed a `BUDLIG.LIME 6X355`, there was no way to say so.
 * `override_total` let her retype the number, which treats the symptom: the wrong
 * classification stayed on the record, and the record is what a future classifier
 * would be trained on.
 *
 * Everything here is a pure function, for three reasons:
 *   1. the browser and the route must agree, so the preview Robin sees is produced
 *      by the SAME code that produces the amount the server stores;
 *   2. the money rules are testable without a database;
 *   3. ENGINEERING-RULES / CLAUDE.md: OCR calls, judgement and ledger maths live
 *      outside the UI so they survive a stack change.
 *
 * WHAT THIS FILE DOES NOT DO: any tax arithmetic. The gross-up, the refusal to
 * apply a blended rate on a mixed receipt, the bounds check and the
 * standard-Canadian-rate validation all live in recomputeBudLightTotal() in
 * lib/classify-receipt.ts and are tested there. This file only flips
 * `is_bud_light` flags and hands the corrected object back to that one function.
 *
 * THE ONE SUBTLETY (read before changing anything): recomputeBudLightTotal uses
 * the model's own `bud_light_total_incl_tax` as corroboration on a mixed receipt
 * (basis `lines_mixed_rate_validated`) -- it accepts that figure when the tax rate
 * it implies is inside the receipt's own bounds AND is a real Canadian rate. That
 * claim is about the MODEL's set of lines. Once a human changes the set, the claim
 * describes a different receipt, and it can validate by coincidence: drop a
 * $12.95 line from a $58.45 claim and the implied rate on the remaining $37.90 is
 * 54%, which is rejected, but other combinations can land within half a point of a
 * real rate and would then be paid out as if corroborated. So when the selection
 * changes we STRIP that field before recomputing. The corrected receipt therefore
 * falls back to the conservative basis (pre-tax sum, or the receipt's own rate when
 * every line is Bud Light) and the admin uses the corrected-amount field if the
 * true tax-inclusive figure is knowable only from the paper. Never an overpay.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */
import {
  recomputeBudLightTotal,
  type OcrResult,
  type RecomputedTotal
} from './classify-receipt'
import { parseMoney } from './money'

/** Longest line description we copy into the audit trail. */
const AUDIT_DESC_MAX = 80

/**
 * Which value wins when a reviewer sends BOTH corrected ticks and a corrected
 * amount. They must not silently disagree, so the rule is explicit, reported back
 * in the response, and written to the audit log:
 *
 *   the ticks always decide the stored CLASSIFICATION,
 *   `override_total` always decides the stored AMOUNT.
 *
 * Refusing the combination was the other option, and it was rejected: the case
 * that needs it is exactly the common one. On a mixed receipt whose tax-inclusive
 * figure cannot be corroborated, recomputeBudLightTotal deliberately reports the
 * PRE-TAX Bud Light sum, so after unticking a mis-tagged line Robin still has to
 * type the tax-inclusive amount off the paper. Forcing her to choose would mean
 * choosing between a correct record and a correct payment, and the payment would
 * win every time, which is the bug this feature exists to remove.
 */
export const AMOUNT_PRECEDENCE = 'override_total' as const

export type AmountSource =
  /** nothing was corrected; whatever is already stored stands */
  | 'unchanged'
  /** the reviewer typed an amount; that amount is stored */
  | 'override_total'
  /** the amount is the server recompute over the corrected ticks */
  | 'corrected_lines'

export type OcrLineLike = Record<string, unknown>

/** The lines array out of a stored ocr_json, or null when there is nothing to correct. */
export function ocrLineObjects(ocr: unknown): OcrLineLike[] | null {
  if (!ocr || typeof ocr !== 'object' || Array.isArray(ocr)) return null
  const lines = (ocr as Record<string, unknown>).lines
  if (!Array.isArray(lines) || lines.length === 0) return null
  return lines.map(l => (l && typeof l === 'object' && !Array.isArray(l) ? (l as OcrLineLike) : {}))
}

/** `is_bud_light` per line as currently stored. Strictly `=== true`, like the recompute. */
export function currentBudLightFlags(ocr: unknown): boolean[] {
  const lines = ocrLineObjects(ocr)
  if (!lines) return []
  return lines.map(l => l.is_bud_light === true)
}

/** Indices of the lines currently ticked. */
export function currentBudLightIndices(ocr: unknown): number[] {
  return currentBudLightFlags(ocr).flatMap((on, i) => (on ? [i] : []))
}

export type ValidationResult =
  | { ok: true; indices: number[] }
  | { ok: false; message: string }

/**
 * `bud_light_lines` arrives over HTTP, so it is untrusted: it decides how much a
 * student is paid. Integers, in range, no duplicates, nothing else.
 */
export function validateBudLightLines(ocr: unknown, raw: unknown): ValidationResult {
  const lines = ocrLineObjects(ocr)
  if (!lines) {
    return {
      ok: false,
      message: 'This receipt has no readable line items, so the Bud Light ticks cannot be corrected. ' +
        'Use the corrected amount instead.'
    }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'bud_light_lines must be an array of line numbers.' }
  }
  const seen = new Set<number>()
  const indices: number[] = []
  for (const v of raw) {
    // `true` is not 1 and "2" is not 2. Number.isInteger rejects both, plus NaN,
    // Infinity and 1.5.
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return {
        ok: false,
        message: `bud_light_lines must contain whole line numbers only. Got ${describeValue(v)}.`
      }
    }
    if (v < 0 || v >= lines.length) {
      return {
        ok: false,
        message: `bud_light_lines refers to line ${v}, but this receipt has ${lines.length} line(s) ` +
          `(valid range 0 to ${lines.length - 1}).`
      }
    }
    if (seen.has(v)) {
      return { ok: false, message: `bud_light_lines lists line ${v} more than once.` }
    }
    seen.add(v)
    indices.push(v)
  }
  indices.sort((a, b) => a - b)
  return { ok: true, indices }
}

function describeValue(v: unknown): string {
  if (typeof v === 'string') return `the string "${v.slice(0, 24)}"`
  if (typeof v === 'boolean') return `the boolean ${v}`
  if (v === null) return 'null'
  if (typeof v === 'number') return `${v}`
  return typeof v
}

export type ChangedLine = {
  index: number
  desc: string
  total: number | null
  /** was it ticked before this correction */
  was: boolean
  /** is it ticked now */
  now: boolean
}

export type BudLightCorrection = {
  /** the requested selection, sorted */
  indices: number[]
  previousIndices: number[]
  previousFlags: boolean[]
  nextFlags: boolean[]
  /** lines switched ON */
  added: number[]
  /** lines switched OFF */
  removed: number[]
  /** added and removed together, sorted */
  changed: number[]
  changedLines: ChangedLine[]
  /** the lines array with corrected flags, ready to write back into ocr_json */
  correctedLines: OcrLineLike[]
  /**
   * Server recompute over the corrected flags. `recomputed.total` is the
   * authoritative amount when no override_total is supplied.
   */
  recomputed: RecomputedTotal
  /** Server recompute over the flags as they were stored, for the before/after delta. */
  previousRecomputed: RecomputedTotal
}

/**
 * Apply a corrected selection and re-derive the total through the one tested
 * implementation. Deterministic: no clock, no ids, so the browser preview and the
 * route produce identical numbers.
 */
export function applyBudLightCorrection(ocr: unknown, indices: number[]): BudLightCorrection {
  const src = (ocr && typeof ocr === 'object' && !Array.isArray(ocr) ? ocr : {}) as Record<string, unknown>
  const lines = ocrLineObjects(ocr) ?? []
  const want = new Set(indices)

  const previousFlags = lines.map(l => l.is_bud_light === true)
  const nextFlags = lines.map((_l, i) => want.has(i))
  const correctedLines = lines.map((l, i) => ({ ...l, is_bud_light: nextFlags[i] }))

  const added: number[] = []
  const removed: number[] = []
  const changedLines: ChangedLine[] = []
  for (let i = 0; i < lines.length; i++) {
    if (previousFlags[i] === nextFlags[i]) continue
    if (nextFlags[i]) added.push(i)
    else removed.push(i)
    changedLines.push({
      index: i,
      desc: String(lines[i].desc ?? '').slice(0, AUDIT_DESC_MAX),
      total: parseMoney(lines[i].total),
      was: previousFlags[i],
      now: nextFlags[i]
    })
  }
  const changed = [...added, ...removed].sort((a, b) => a - b)

  // See the file header: a model claim about a different set of lines must not be
  // allowed to corroborate a tax rate for this one.
  const recomputeInput: Record<string, unknown> = { ...src, lines: correctedLines }
  if (changed.length > 0) delete recomputeInput.bud_light_total_incl_tax

  return {
    indices: [...indices].sort((a, b) => a - b),
    previousIndices: previousFlags.flatMap((on, i) => (on ? [i] : [])),
    previousFlags,
    nextFlags,
    added,
    removed,
    changed,
    changedLines,
    correctedLines,
    recomputed: recomputeBudLightTotal(recomputeInput as unknown as OcrResult),
    previousRecomputed: recomputeBudLightTotal(src as unknown as OcrResult)
  }
}

export type CorrectionRefusal = { ok: false; message: string }

export type CorrectionPlan = {
  ok: true
  /** null when no correction was sent, or when the selection matches what is stored */
  correction: BudLightCorrection | null
  /** true only when at least one tick actually moved */
  changed: boolean
  amountSource: AmountSource
  /** the amount to store, or null to leave the stored amount alone */
  amount: number | null
}

/**
 * The whole decision about what a `decide` request means for the classification
 * and the amount, in one testable place. The route does the IO; this decides.
 *
 * `overrideTotal` must already be parsed and range-checked by the caller.
 */
export function planReceiptCorrection(input: {
  ocrJson: unknown
  /** undefined or null = the reviewer did not touch the ticks */
  budLightLines: unknown
  overrideTotal: number | null
  decision: 'approved' | 'rejected'
}): CorrectionPlan | CorrectionRefusal {
  const { ocrJson, budLightLines, overrideTotal, decision } = input

  const supplied = budLightLines !== undefined && budLightLines !== null
  if (!supplied) {
    return {
      ok: true,
      correction: null,
      changed: false,
      amountSource: overrideTotal !== null ? 'override_total' : 'unchanged',
      amount: overrideTotal
    }
  }

  if (decision !== 'approved') {
    return {
      ok: false,
      message: 'Bud Light line corrections only apply when approving a receipt. ' +
        'To record that nothing on this receipt is Bud Light, reject it and say why.'
    }
  }

  const validated = validateBudLightLines(ocrJson, budLightLines)
  if (!validated.ok) return validated

  if (validated.indices.length === 0) {
    // Silently paying $0 is the failure mode here: the reviewer would see a green
    // "Approved" and the student would get nothing with no warning email, because
    // an approved receipt is not a rejected one.
    return {
      ok: false,
      message: 'No line is ticked as Bud Light, so there is nothing to reimburse. ' +
        'Reject the receipt if it has no Bud Light on it. If the line items are unreadable ' +
        'but the receipt is genuine, leave the ticks alone and enter a corrected amount.'
    }
  }

  const correction = applyBudLightCorrection(ocrJson, validated.indices)

  if (correction.changed.length === 0) {
    // Nothing moved. Do not rewrite ocr_json and do not re-derive the amount: a
    // no-op request must not be able to change what is stored (stripping the
    // model claim would silently drop a validated gross-up to the pre-tax sum).
    return {
      ok: true,
      correction: null,
      changed: false,
      amountSource: overrideTotal !== null ? 'override_total' : 'unchanged',
      amount: overrideTotal
    }
  }

  return {
    ok: true,
    correction,
    changed: true,
    amountSource: overrideTotal !== null ? 'override_total' : 'corrected_lines',
    amount: overrideTotal !== null ? overrideTotal : correction.recomputed.total
  }
}

/**
 * The ocr_json to persist.
 *
 * WHERE THE CORRECTED CLASSIFICATION LIVES, and why:
 *   - `lines[].is_bud_light` carries the CORRECTED flags. Everything that already
 *     reads a receipt (the admin table, recomputeBudLightTotal, anything future)
 *     then shows the classification that was actually paid, which is the point:
 *     the record has to match the money.
 *   - `model_classification` keeps the AI's ORIGINAL flags and its original
 *     `bud_light_total_incl_tax`, written once and never overwritten, so a second
 *     correction cannot erase what the model first said. That is the training
 *     signal CLAUDE.md wants: model output on one side, human answer on the other.
 *   - `admin_classification` records who corrected what, both totals and the basis.
 *   - top-level `bud_light_total_incl_tax` is set to the server-recomputed total so
 *     the stored object is self-consistent: recomputing from it later reproduces
 *     the same number. It is NOT deleted, because the cross-receipt fraud
 *     heuristic in app/api/receipts/ocr/route.ts reads this field off OTHER
 *     receipts and a missing value would silently drop this receipt out of the
 *     "clustered near the balance" check.
 *
 * All of it lives inside the existing `ocr_json` jsonb, so no migration is needed
 * and the classification cannot drift apart from the receipt row it belongs to.
 */
export function annotateCorrectedOcr(
  ocr: unknown,
  correction: BudLightCorrection,
  meta: {
    at: string
    by: string
    amountSource: AmountSource
    /** the amount actually stored on the receipt row */
    amountStored: number | null
    reason: string
  }
): Record<string, unknown> {
  const src = (ocr && typeof ocr === 'object' && !Array.isArray(ocr) ? ocr : {}) as Record<string, unknown>
  const lines = ocrLineObjects(ocr) ?? []

  const out: Record<string, unknown> = {
    ...src,
    lines: correction.correctedLines,
    bud_light_total_incl_tax: correction.recomputed.total
  }

  // Written once. A prior correction already holds the model's own output.
  if (!src.model_classification) {
    out.model_classification = {
      captured_at: meta.at,
      note: 'The AI original, kept for training. lines[].is_bud_light above may have been corrected by an admin.',
      bud_light_total_incl_tax: parseMoney(src.bud_light_total_incl_tax),
      lines: lines.map((l, i) => ({
        index: i,
        desc: String(l.desc ?? '').slice(0, AUDIT_DESC_MAX),
        total: parseMoney(l.total),
        is_bud_light: correction.previousFlags[i]
      }))
    }
  }

  out.admin_classification = {
    corrected_at: meta.at,
    corrected_by: meta.by,
    reason: meta.reason.slice(0, 1000),
    bud_light_lines: correction.indices,
    previous_bud_light_lines: correction.previousIndices,
    lines_added: correction.added,
    lines_removed: correction.removed,
    recomputed_total: correction.recomputed.total,
    recompute_basis: correction.recomputed.basis,
    previous_total: correction.previousRecomputed.total,
    amount_source: meta.amountSource,
    amount_stored: meta.amountStored
  }

  return out
}

/**
 * The audit_log row body for a corrected receipt.
 *
 * audit_log columns are exactly actor_id, actor_role, entity, entity_id, action,
 * before_json, after_json. There is no `meta` column, and PostgREST drops an
 * unknown key without complaining, so an extra field means the detail is lost
 * silently. This builder returns only the three payload fields; the route adds the
 * actor columns.
 */
export function buildCorrectionAudit(args: {
  previousStatus: string
  decision: string
  previousTotal: number | null
  storedTotal: number | null
  correction: BudLightCorrection
  overrideTotal: number | null
  amountSource: AmountSource
  reason: string
  actorLabel: string
}): { action: string; before_json: Record<string, unknown>; after_json: Record<string, unknown> } {
  const { correction } = args
  return {
    action: 'correct_bud_light_lines',
    before_json: {
      status: args.previousStatus,
      bud_light_total_incl_tax: args.previousTotal,
      bud_light_lines: correction.previousIndices,
      recomputed_from_lines: correction.previousRecomputed.total,
      recompute_basis: correction.previousRecomputed.basis
    },
    after_json: {
      status: args.decision,
      bud_light_total_incl_tax: args.storedTotal,
      bud_light_lines: correction.indices,
      lines_added: correction.added,
      lines_removed: correction.removed,
      changed_lines: correction.changedLines,
      recomputed_from_lines: correction.recomputed.total,
      recompute_basis: correction.recomputed.basis,
      override_total: args.overrideTotal,
      amount_source: args.amountSource,
      reason: args.reason,
      corrected_by: args.actorLabel
    }
  }
}
