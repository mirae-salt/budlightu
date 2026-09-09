/**
 * The badge beside an invoice, for a BAM who submitted more than one receipt.
 *
 * It came from a map keyed `bam_id_period` and assigned inside a loop, so an arbitrary
 * row won. On 2026-09-09 thirteen BAMs had more than one September receipt and four had
 * receipts in different states at the same time. Every case below is one of those.
 */
import { describe, it, expect } from 'vitest'
import { summarizeReceipts, reimbursementOnInvoice, isReimbursementLine } from '../lib/receipt-badge'

const ok = (n: number) => ({ status: 'auto_pass', bud_light_total_incl_tax: n })
const approved = (n: number) => ({ status: 'approved', bud_light_total_incl_tax: n })
const review = (n: number) => ({ status: 'review', bud_light_total_incl_tax: n })
const rejected = (n: number) => ({ status: 'rejected', bud_light_total_incl_tax: n })

describe('summarizeReceipts adds them up instead of picking one', () => {
  it('sums both of Royce Barnes-Sutherland-Johnson', () => {
    // The badge said $137.15 and ignored the $20.36.
    const out = summarizeReceipts([ok(137.15), ok(20.36)])
    expect(out.status).toBe('ok')
    expect(out.count).toBe(2)
    expect(out.spentCad).toBe(157.51)
  })

  it('handles a single receipt the same way', () => {
    expect(summarizeReceipts([ok(75)])).toEqual({ status: 'ok', count: 1, spentCad: 75 })
  })

  it('says nothing when there are no receipts', () => {
    expect(summarizeReceipts([]).status).toBe('none')
    expect(summarizeReceipts([]).spentCad).toBe(0)
  })
})

describe('one receipt still waiting outranks everything', () => {
  it('Eesha Nandha: one in review beside one auto-passed reads as pending', () => {
    // If the auto-passed row won, the invoice showed a green badge and lost the amber
    // left border, so the queue looked clear while she still had a receipt in it.
    expect(summarizeReceipts([ok(52.33), review(74.98)]).status).toBe('pending')
  })

  it('Thomas Ambrosio: review, approved and rejected together read as pending', () => {
    // Three states on one invoice. Row order decided the colour, so the same invoice
    // could show green, amber or red.
    expect(summarizeReceipts([review(203.38), approved(16.95), rejected(0)]).status).toBe('pending')
  })

  it('order of the rows changes nothing', () => {
    const rows = [review(10), approved(20), rejected(30)]
    const forward = summarizeReceipts(rows).status
    const backward = summarizeReceipts([...rows].reverse()).status
    expect(forward).toBe(backward)
  })
})

describe('a rejection is a decision, so it only shows when nothing passed', () => {
  it('Ryerson Wilgar: rejected beside auto-passed reads as ok', () => {
    // His invoice does have a valid reimbursement behind it.
    expect(summarizeReceipts([rejected(0), ok(34.19)]).status).toBe('ok')
  })

  it('rejected on its own reads as rejected', () => {
    expect(summarizeReceipts([rejected(0), rejected(0)]).status).toBe('rejected')
  })

  it('Thomas Levesque: approved beside auto-passed reads as ok', () => {
    expect(summarizeReceipts([approved(85.26), ok(24.32), ok(20.66), ok(10.25)]).status).toBe('ok')
  })
})

describe('spend counts only what was actually allowed', () => {
  it('leaves out a receipt still being decided', () => {
    // Counting it would show a total the invoice does not pay.
    expect(summarizeReceipts([ok(100), review(50)]).spentCad).toBe(100)
  })

  it('leaves out a rejected one', () => {
    expect(summarizeReceipts([ok(100), rejected(999)]).spentCad).toBe(100)
  })

  it('survives an unreadable amount without becoming NaN', () => {
    const out = summarizeReceipts([ok(10), { status: 'auto_pass', bud_light_total_incl_tax: null }])
    expect(out.spentCad).toBe(10)
  })
})

describe('the badge amount comes off the invoice, not the receipts', () => {
  const payload = {
    lines: [
      { description: 'Brand Activation Manager monthly payment (September Payment)', total: 218.75 },
      { description: 'Reimbursement for sponsorship allowance (September)', total: 150 }
    ]
  }

  it('reads the reimbursement line, which is what the invoice pays', () => {
    // Royce spent $157.51 and is paid the cap. The badge has to match the total beside it.
    expect(reimbursementOnInvoice(payload)).toBe(150)
  })

  it('is null when the invoice has no reimbursement line yet', () => {
    expect(reimbursementOnInvoice({ lines: [payload.lines[0]] })).toBe(null)
  })

  it('is null rather than zero for a payload it cannot read', () => {
    expect(reimbursementOnInvoice(null)).toBe(null)
    expect(reimbursementOnInvoice({})).toBe(null)
  })

  it('does not mistake an ad-hoc line for the reimbursement', () => {
    expect(isReimbursementLine({ description: 'BLU Onboarding (Hotel Parking)' })).toBe(false)
    expect(isReimbursementLine({ description: 'Reimbursement for sponsorship allowance' })).toBe(true)
  })
})

describe('the badge vocabulary is one list, because the type checker cannot see it', () => {
  /*
   * Both sides are strings, so nothing catches a drift at compile time. It happened while
   * writing this: the server started returning 'ok' and the page still expected
   * 'auto_pass', which sent every good invoice to the muted dash. This asserts that every
   * value summarizeReceipts can produce is one the page renders.
   */
  const RENDERED_BY_THE_PAGE = ['ok', 'pending', 'rejected', 'none']

  it.each([
    [[ok(10)], 'ok'],
    [[review(10)], 'pending'],
    [[rejected(10)], 'rejected'],
    [[], 'none']
  ] as const)('%# produces a status the page knows', (rows, expected) => {
    const status = summarizeReceipts([...rows]).status
    expect(status).toBe(expected)
    expect(RENDERED_BY_THE_PAGE).toContain(status)
  })
})
