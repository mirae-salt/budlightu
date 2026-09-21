/**
 * Do not send an invoice while a receipt for that month is still waiting on a decision.
 *
 * The case this came from, 2026-08-13: a $58.45 receipt was approved, then reverted, which
 * recomputed the ledger to $0 and left the receipt in 'review'. Batch approve reported success
 * on an invoice carrying no reimbursement while that money sat undecided in the queue. On a
 * live cohort the invoice reaches AP as final, on net-15, and the student is short.
 *
 * The six states are pinned individually because the interesting part is WHICH ones block. Two
 * of the allowed ones are allowed for opposite reasons, and getting either wrong is a real
 * fault: blocking on ocr_failed would stall a payment forever, and allowing 'review' is the
 * bug this exists to prevent.
 */
import { describe, it, expect } from 'vitest'
import { undecidedReceiptsProblem } from '../lib/invoice-ledger'

type Row = Record<string, unknown>

/** Minimal stand-in for the one query the function makes. */
function fakeDb(receipts: Row[], error?: string) {
  let captured: { statuses?: unknown[] } = {}
  const api: Record<string, unknown> = {}
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: (_col: string, vs: unknown[]) => { captured.statuses = vs; return chain },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(
        error
          ? { data: null, error: { message: error } }
          : { data: receipts.filter(r => (captured.statuses ?? []).includes(r.status)), error: null }
      ).then(res, rej)
  }
  api.from = () => chain
  api._captured = captured
  return api as never
}

const OK = null

describe('undecidedReceiptsProblem', () => {
  it('blocks while a receipt is still in review', async () => {
    const problem = await undecidedReceiptsProblem(fakeDb([{ id: 'r1', status: 'review' }]), 'b1', '2026-08-01')
    expect(problem).toBeTruthy()
    expect(problem).toContain('1 review')
    // Says what to do. A refusal with no next step gets worked around.
    expect(problem).toContain('Receipts page')
  })

  it('blocks on pending, because OCR has not finished', async () => {
    expect(await undecidedReceiptsProblem(fakeDb([{ status: 'pending' }]), 'b1', '2026-08-01')).toBeTruthy()
  })

  it('allows auto_pass: its money is already in the ledger', async () => {
    // This blocked until 2026-09-21, on the belief that auto_pass was not yet settled. The
    // ledger counts pending/auto_pass/review/approved alike, so an auto-passed receipt is in
    // spent_cad from the moment it lands and is already inside the invoice's reimbursement
    // line. Blocking held 39 of September's live invoices, every one of them correct.
    expect(await undecidedReceiptsProblem(fakeDb([{ status: 'auto_pass' }]), 'b1', '2026-08-01')).toBe(OK)
  })

  it('still blocks when a review receipt sits beside an auto-passed one', async () => {
    // The gate that matters is unchanged: one undecided receipt holds the invoice no matter
    // what else the month contains.
    const problem = await undecidedReceiptsProblem(
      fakeDb([{ status: 'auto_pass' }, { status: 'review' }]), 'b1', '2026-08-01'
    )
    expect(problem).toBeTruthy()
    expect(problem).toContain('1 review')
    expect(problem).not.toContain('auto_pass')
  })

  it('allows an approved receipt: decided, and the money is in the ledger', async () => {
    expect(await undecidedReceiptsProblem(fakeDb([{ status: 'approved' }]), 'b1', '2026-08-01')).toBe(OK)
  })

  it('allows a rejected receipt: decided, and worth nothing', async () => {
    expect(await undecidedReceiptsProblem(fakeDb([{ status: 'rejected' }]), 'b1', '2026-08-01')).toBe(OK)
  })

  it('allows ocr_failed, because nobody can decide a receipt that will not read', async () => {
    // Blocking here would stall the payment forever on a file that never becomes readable.
    // It is surfaced in the review queue and excluded from shortfall judgement instead.
    expect(await undecidedReceiptsProblem(fakeDb([{ status: 'ocr_failed' }]), 'b1', '2026-08-01')).toBe(OK)
  })

  it('allows a salary-only month with no receipts at all', async () => {
    expect(await undecidedReceiptsProblem(fakeDb([]), 'b1', '2026-08-01')).toBe(OK)
  })

  it('counts every undecided receipt, not just the first', async () => {
    const problem = await undecidedReceiptsProblem(
      fakeDb([{ status: 'review' }, { status: 'review' }, { status: 'pending' }, { status: 'approved' }]),
      'b1', '2026-08-01'
    )
    expect(problem).toContain('3 receipt(s)')
    expect(problem).toContain('2 review')
    expect(problem).toContain('1 pending')
  })

  it('FAILS CLOSED when the receipts table cannot be read', async () => {
    // Not knowing whether a decision is outstanding is not the same as there being none.
    const problem = await undecidedReceiptsProblem(fakeDb([], 'connection reset'), 'b1', '2026-08-01')
    expect(problem).toBeTruthy()
    expect(problem).toContain('connection reset')
  })
})
