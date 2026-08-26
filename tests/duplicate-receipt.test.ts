/**
 * Cross-BAM duplicate detection.
 *
 * This function's output goes in front of a reviewer as "somebody else already claimed
 * this", which is close to an accusation, so the tests lean hard on the cases where it
 * must stay quiet. A false positive here means a student who did nothing wrong gets
 * held out of a payment run while a human works out why.
 *
 * The gap this closes: both existing duplicate checks compared a BAM against
 * themselves. Robin, watching the 2026-08-26 testing session, said "I think it will
 * flag if they're all using same receipt." It would not have.
 */
import { describe, it, expect } from 'vitest'
import { findCrossBamDuplicate, type DuplicateCandidate } from '../lib/duplicate-receipt'

const ALICE = 'aaaaaaaa-0000-0000-0000-000000000001'
const BOB = 'bbbbbbbb-0000-0000-0000-000000000002'

const bobsReceipt: DuplicateCandidate = {
  id: 'r-bob-1',
  bamId: BOB,
  bamName: 'Bob Marsh',
  period: '2026-09-01',
  sha256: 'ffff1111',
  store: 'LCBO Leslieville',
  date: '2026-09-04',
  grandTotal: 71.4
}

const subject = {
  receiptId: 'r-alice-1',
  bamId: ALICE,
  sha256: 'ffff1111',
  store: 'LCBO Leslieville',
  date: '2026-09-04',
  grandTotal: 71.4
}

describe('the same file submitted by two people', () => {
  it('is caught, and says who already has it', () => {
    const m = findCrossBamDuplicate(subject, [bobsReceipt])
    expect(m).not.toBeNull()
    expect(m!.kind).toBe('file')
    expect(m!.bamId).toBe(BOB)
    expect(m!.receiptId).toBe('r-bob-1')
    expect(m!.reason).toContain('Bob Marsh')
    expect(m!.reason).toContain('r-bob-1')
  })

  it('is reported as a file match even when the content also matches', () => {
    // Both signals fire here. The file one is provable and the content one is a
    // judgement call, so a reviewer must be shown the provable one.
    const m = findCrossBamDuplicate(subject, [bobsReceipt])
    expect(m!.kind).toBe('file')
  })

  it('falls back to a short id when the other BAM has no name on file', () => {
    const m = findCrossBamDuplicate(subject, [{ ...bobsReceipt, bamName: null }])
    expect(m!.reason).toContain('BAM bbbbbbbb')
  })

  it('is caught across months, not just inside one', () => {
    const m = findCrossBamDuplicate(subject, [{ ...bobsReceipt, period: '2026-11-01' }])
    expect(m!.kind).toBe('file')
    expect(m!.reason).toContain('2026-11')
  })
})

describe('a re-photographed receipt, where the bytes differ', () => {
  it('is caught on store, date and total together', () => {
    const m = findCrossBamDuplicate(subject, [{ ...bobsReceipt, sha256: 'different-bytes' }])
    expect(m!.kind).toBe('content')
    expect(m!.reason).toContain('A human should confirm')
  })

  it('tolerates case and spacing in the store name', () => {
    const m = findCrossBamDuplicate(subject, [
      { ...bobsReceipt, sha256: 'x', store: '  lcbo   LESLIEVILLE ' }
    ])
    expect(m!.kind).toBe('content')
  })

  it('treats a cent of float noise as the same amount', () => {
    const m = findCrossBamDuplicate(subject, [
      { ...bobsReceipt, sha256: 'x', grandTotal: 71.400001 }
    ])
    expect(m!.kind).toBe('content')
  })
})

describe('what it must NOT flag', () => {
  it('the uploader own receipts, however identical', () => {
    // Covered elsewhere, with better messages: the upload route rejects a repeat
    // sha256 and the OCR route has its own same-BAM history check.
    const mine = { ...bobsReceipt, id: 'r-alice-2', bamId: ALICE, bamName: 'Alice Kerr' }
    expect(findCrossBamDuplicate(subject, [mine])).toBeNull()
  })

  it('the receipt being classified right now', () => {
    const self = { ...bobsReceipt, id: 'r-alice-1', bamId: ALICE }
    expect(findCrossBamDuplicate(subject, [self])).toBeNull()
  })

  it('two blank receipts, which is how a check starts accusing at random', () => {
    const blankSubject = { receiptId: 'r1', bamId: ALICE, sha256: '', store: '', date: '', grandTotal: null }
    const blankOther: DuplicateCandidate = { id: 'r2', bamId: BOB, sha256: '', store: '', date: '', grandTotal: null }
    expect(findCrossBamDuplicate(blankSubject, [blankOther])).toBeNull()
  })

  it('a missing store, even when the date and total line up', () => {
    const noStore = { ...subject, sha256: '', store: null }
    expect(findCrossBamDuplicate(noStore, [{ ...bobsReceipt, sha256: 'x', store: null }])).toBeNull()
  })

  it('a missing date, even when the store and total line up', () => {
    const noDate = { ...subject, sha256: '', date: '' }
    expect(findCrossBamDuplicate(noDate, [{ ...bobsReceipt, sha256: 'x', date: '' }])).toBeNull()
  })

  it('a missing total, even when the store and date line up', () => {
    const noTotal = { ...subject, sha256: '', grandTotal: null }
    expect(findCrossBamDuplicate(noTotal, [{ ...bobsReceipt, sha256: 'x', grandTotal: null }])).toBeNull()
  })

  it('two people at the same store on the same day for different amounts', () => {
    // The ordinary case this must survive: one campus, one LCBO, a Saturday.
    const m = findCrossBamDuplicate(
      { ...subject, sha256: '', grandTotal: 48.2 },
      [{ ...bobsReceipt, sha256: 'x', grandTotal: 71.4 }]
    )
    expect(m).toBeNull()
  })

  it('the same amount at the same store on different days', () => {
    const m = findCrossBamDuplicate(
      { ...subject, sha256: '' },
      [{ ...bobsReceipt, sha256: 'x', date: '2026-09-05' }]
    )
    expect(m).toBeNull()
  })

  it('an empty candidate list', () => {
    expect(findCrossBamDuplicate(subject, [])).toBeNull()
  })
})

describe('it reports the first real match rather than scanning forever', () => {
  it('prefers a file match found late over a content match found early', () => {
    const contentOnly: DuplicateCandidate = { ...bobsReceipt, id: 'r-content', sha256: 'other' }
    const fileMatch: DuplicateCandidate = {
      id: 'r-file', bamId: BOB, bamName: 'Bob Marsh', period: '2026-09-01',
      sha256: 'ffff1111', store: null, date: null, grandTotal: null
    }
    const m = findCrossBamDuplicate(subject, [contentOnly, fileMatch])
    expect(m!.kind).toBe('file')
    expect(m!.receiptId).toBe('r-file')
  })
})
