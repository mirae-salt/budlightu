/**
 * One line about a BAM's receipts for a month, for the invoice list.
 *
 * The badge beside an invoice used to come from a map keyed `bam_id_period` that was
 * written inside a loop, so for anyone who submitted more than one receipt an arbitrary
 * row won and the badge described that row alone. On 2026-09-09 that was thirteen of the
 * BAMs with a September invoice, and four of them had receipts in different states at the
 * same time.
 *
 * The amount being wrong was the visible half. Royce Barnes-Sutherland-Johnson submitted
 * $137.15 and $20.36 and the badge said $137.15, next to an invoice that correctly paid
 * the $150 cap.
 *
 * The colour being wrong was worse. Thomas Ambrosio had one receipt in review, one
 * approved and one rejected, so the same invoice could show green, amber or red depending
 * on row order. Eesha Nandha had one in review and one auto-passed: if the auto-passed row
 * won, the invoice showed a green badge and lost its amber left border, which is the cue
 * telling a program manager she still has something to decide. A badge that says "done"
 * while work is outstanding is the one failure this badge must not have.
 */

/** Receipt states as the badge cares about them. */
export type BadgeStatus = 'pending' | 'ok' | 'rejected' | 'none'

export type ReceiptSummary = {
  status: BadgeStatus
  /** How many receipts the BAM has for the period. Lets the badge say "2 receipts". */
  count: number
  /** Sum of what those receipts came to, before the monthly cap. */
  spentCad: number
}

/**
 * Worst first, because the badge answers "is there anything left for me to do here".
 *
 *   review              -> pending. Outranks everything: one undecided receipt is work.
 *   approved/auto_pass  -> ok. The invoice has a reimbursement behind it.
 *   rejected only       -> rejected. A rejection is a decision, so it only shows when
 *                          nothing else passed. Ryerson Wilgar has one rejected and one
 *                          auto-passed, and his invoice does have a valid reimbursement.
 *   nothing readable    -> none.
 */
export function summarizeReceipts(
  rows: Array<{ status?: string | null; bud_light_total_incl_tax?: unknown }>
): ReceiptSummary {
  let hasPending = false
  let hasOk = false
  let hasRejected = false
  let spentCad = 0

  for (const r of rows ?? []) {
    const status = String(r?.status ?? '')
    if (status === 'review') hasPending = true
    else if (status === 'approved' || status === 'auto_pass') hasOk = true
    else if (status === 'rejected') hasRejected = true

    // Rejected receipts are not spend. Neither is one still being decided: counting it
    // would show a total the invoice does not pay.
    if (status === 'approved' || status === 'auto_pass') {
      const n = Number(r?.bud_light_total_incl_tax)
      if (Number.isFinite(n) && n > 0) spentCad += n
    }
  }

  const status: BadgeStatus =
    hasPending ? 'pending'
    : hasOk ? 'ok'
    : hasRejected ? 'rejected'
    : 'none'

  return { status, count: (rows ?? []).length, spentCad: Math.round(spentCad * 100) / 100 }
}

/** Same predicate the server, the page and the send-time ledger check use. */
export function isReimbursementLine(line: { description?: unknown }): boolean {
  return typeof line?.description === 'string' && /reimbursement/i.test(line.description)
}

/**
 * What the badge shows: the reimbursement this invoice actually pays.
 *
 * Taken off the invoice rather than from the receipts, so the badge and the total beside
 * it can never disagree. When a BAM spends over the monthly cap the two figures differ on
 * purpose, and the caller puts the spend in the tooltip instead of the badge, because the
 * paid figure is the one that matches the document.
 */
export function reimbursementOnInvoice(payload: unknown): number | null {
  const lines = (payload as { lines?: Array<{ description?: unknown; total?: unknown }> })?.lines
  if (!Array.isArray(lines)) return null
  let total = 0
  let found = false
  for (const l of lines) {
    if (!isReimbursementLine(l)) continue
    const n = Number(l?.total)
    if (Number.isFinite(n)) { total += n; found = true }
  }
  return found ? Math.round(total * 100) / 100 : null
}
