/**
 * Reading a stored decision reason.
 *
 * The strings below are real, copied from rows in the database on 2026-09-02. The stored
 * text is the audit record and is never rewritten, so everything here is about how it is
 * presented.
 */
import { describe, it, expect } from 'vitest'
import { parseReason, summarizeReason } from '../lib/receipt-reason'

const THOMAS =
  'bar_restaurant: this is a bar or restaurant receipt, not a retail purchase -- not eligible for reimbursement | ' +
  'total_mismatch: subtotal($19.00) + tax($2.47) = $21.47 but grand_total is $24.32'

const RYERSON = 'No Bud Light items detected on this receipt | no_store: no identifiable store name on receipt'

describe('parseReason', () => {
  it('splits one string into one finding per check', () => {
    expect(parseReason(THOMAS)).toHaveLength(2)
  })

  it('turns the machine code into a label and drops it from the sentence', () => {
    const [first] = parseReason(THOMAS)
    expect(first.code).toBe('bar_restaurant')
    expect(first.label).toBe('Bar or restaurant')
    expect(first.detail).not.toContain('bar_restaurant:')
  })

  it('makes the clause break a full stop and capitalises what follows', () => {
    const [first] = parseReason(THOMAS)
    expect(first.detail).toBe('This is a bar or restaurant receipt, not a retail purchase. Not eligible for reimbursement')
    expect(first.detail).not.toContain('--')
  })

  it('replaces column names that leaked into a sentence', () => {
    const [, second] = parseReason(THOMAS)
    expect(second.detail).not.toContain('grand_total')
    expect(second.detail).toContain('the receipt total')
    // Capitalised, because the clause no longer sits behind a code prefix.
    expect(second.detail).toContain('Subtotal ($19.00)')
    expect(second.detail).toContain('tax ($2.47)')
  })

  it('keeps the amounts exactly as stored', () => {
    const [, second] = parseReason(THOMAS)
    for (const amount of ['$19.00', '$2.47', '$21.47', '$24.32']) {
      expect(second.detail).toContain(amount)
    }
  })

  it('keeps free text that has no code, rather than dropping it', () => {
    const parts = parseReason(RYERSON)
    expect(parts).toHaveLength(2)
    expect(parts[0].code).toBeNull()
    expect(parts[0].detail).toBe('No Bud Light items detected on this receipt')
    expect(parts[1].label).toBe('No store name')
  })

  it('humanises a code nobody has labelled yet', () => {
    // A check added later must still read as something, not as a raw token.
    const [p] = parseReason('some_new_check: it found something')
    expect(p.code).toBe('some_new_check')
    expect(p.label).toBe('Some new check')
    expect(p.detail).toBe('It found something')
  })

  it('does not mistake a sentence containing a colon for a code', () => {
    const [p] = parseReason('Meets criteria [Bud Light lines corrected: +CONSIGNE]')
    expect(p.code).toBeNull()
    expect(p.detail).toContain('+CONSIGNE')
  })

  it('handles nothing at all', () => {
    expect(parseReason('')).toEqual([])
    expect(parseReason(null)).toEqual([])
    expect(parseReason(undefined)).toEqual([])
    expect(parseReason(' | | ')).toEqual([])
  })

  it('loses none of the findings, however many there are', () => {
    const four = 'a_one: first | b_two: second | c_three: third | plain text last'
    expect(parseReason(four)).toHaveLength(4)
  })
})

describe('summarizeReason', () => {
  it('names the first finding and counts the rest', () => {
    expect(summarizeReason(THOMAS)).toBe('Bar or restaurant and 1 more')
  })

  it('does not say "and 0 more" for a single finding', () => {
    expect(summarizeReason('over_balance: Bud Light total $88.00 exceeds available balance $60.00'))
      .toBe('Over remaining balance')
  })

  it('is empty for an empty reason', () => {
    expect(summarizeReason('')).toBe('')
  })
})
