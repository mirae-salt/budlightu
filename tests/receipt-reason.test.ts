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

describe('the auto-approved sentence', () => {
  it('reads an old stored row as a plain statement about the receipt', () => {
    const [p] = parseReason('Meets all auto-pass thresholds (recomputed $62.14 from line items)')
    expect(p).toMatchObject({ code: 'auto_approved', label: 'Auto-approved' })
    expect(p.detail).toBe('The Bud Light items on this receipt add up to $62.14')
    expect(p.detail).not.toMatch(/recomputed|threshold/i)
  })

  it('reads a thousand-dollar total', () => {
    expect(parseReason('meets all auto-pass thresholds (recomputed $1,127.77 from line items)')[0].detail).toContain('$1,127.77')
  })

  it('reads the wording new rows are written with', () => {
    const [p] = parseReason('auto_approved: the Bud Light items on this receipt add up to $127.77')
    expect(p).toMatchObject({ label: 'Auto-approved' })
    expect(p.detail).toBe('The Bud Light items on this receipt add up to $127.77')
  })

  it('summarises to one short label', () => {
    expect(summarizeReason('Meets all auto-pass thresholds (recomputed $56.99 from line items)')).toBe('Auto-approved')
  })

  it('leaves other free text alone', () => {
    expect(parseReason('Meets Bud Light reimbursement criteria')[0].detail).toBe('Meets Bud Light reimbursement criteria')
  })
})

describe('the amount note an admin approval leaves', () => {
  it('says nothing when the amount did not move', () => {
    const [p] = parseReason('Meets Bud Light reimbursement criteria [amount corrected by admin: $179.85 -> $179.85, recomputed from corrected Bud Light lines] [Bud Light lines corrected: +Deposit (DEP)]')
    expect(p.detail).not.toMatch(/amount corrected|recomputed/)
    expect(p.detail).toContain('Meets Bud Light reimbursement criteria')
    expect(p.detail).toContain('Bud Light lines corrected: +Deposit (DEP)')
  })

  it('says it plainly when the amount did move', () => {
    const [p] = parseReason('Meets Bud Light reimbursement criteria [amount corrected by admin: $13.00 -> $14.53]')
    expect(p.detail).toBe('Meets Bud Light reimbursement criteria (amount changed from $13.00 to $14.53)')
  })

  it('handles an amount that had no value before', () => {
    const [p] = parseReason('Meets Bud Light reimbursement criteria [amount corrected by admin: none -> $96.34]')
    expect(p.detail).toContain('amount changed from nothing to $96.34')
  })
})


describe('delivery app orders', () => {
  const OLD = 'delivery_app: this is a delivery app order (Uber Eats, Instacart, etc.) -- needs admin review'

  it('says what to check: the fees and the tip are not reimbursed', () => {
    const [p] = parseReason(OLD)
    expect(p.label).toBe('Delivery app')
    expect(p.detail).toMatch(/delivery, service and bag fees and a tip/)
    expect(p.detail).toMatch(/not reimbursed/)
  })

  it('rows stored before the wording changed read the same as new ones', () => {
    const NEW = 'delivery_app: this is a delivery app order (Uber Eats, Instacart, etc.). The total usually includes delivery, service and bag fees and a tip, which are not reimbursed -- check that only the Bud Light items and their tax are counted'
    expect(parseReason(OLD)[0].detail).toBe(parseReason(NEW)[0].detail)
  })

  it('a delivery clause beside another finding keeps both', () => {
    const parts = parseReason(`${OLD} | unreadable_amounts: 2 line total(s) could not be read as a number`)
    expect(parts.map(p => p.code)).toEqual(['delivery_app', 'unreadable_amounts'])
  })
})

describe('the auto-approved clause beside a real finding', () => {
  it('is left out, so a Review row does not open with "Auto-approved"', () => {
    const parts = parseReason('auto_approved: the Bud Light items on this receipt add up to $43.23 | delivery_app: x -- y')
    expect(parts.map(p => p.code)).toEqual(['delivery_app'])
  })
  it('stands alone when it is the only thing said', () => {
    expect(parseReason('auto_approved: the Bud Light items on this receipt add up to $43.23').map(p => p.code)).toEqual(['auto_approved'])
  })
})
