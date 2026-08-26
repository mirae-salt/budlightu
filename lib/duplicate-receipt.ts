/**
 * Has somebody ELSE already claimed this receipt?
 *
 * WHY THIS EXISTS
 *
 * Two duplicate checks already ran and both looked only at the uploader's own
 * receipts: app/api/portal/upload rejects a re-upload of the same sha256 by the same
 * BAM, and app/api/receipts/ocr flags the same store/date/total by the same BAM.
 * Neither could see across people, so the same photo forwarded to a friend paid twice.
 *
 * In the 2026-08-26 testing session Robin said, watching testers pick receipts, "I
 * think it will flag if they're all using same receipt." It would not have. The gap was
 * found by reading the query, not by reproducing it: the testers ended up using
 * different receipts, so nothing in the data showed it. lib/classify-receipt has always
 * documented its `duplicateHash` input as "same sha256 already accepted for ANOTHER
 * bam this period" and has always been handed a same-BAM answer.
 *
 * TWO SIGNALS, DELIBERATELY
 *
 *   sha256   the identical file. An AirDrop, a forwarded screenshot, a shared album.
 *            Exact, free, and impossible to hit by accident: two people photographing
 *            one piece of paper produce different bytes.
 *
 *   content  the same store, date and grand total read off the paper. Catches the same
 *            receipt re-photographed or re-encoded, which sha256 cannot see.
 *
 * The content signal is the looser one, so it requires all three fields to be present
 * and to match. A missing store or a missing date is not a match, because "two blanks
 * are equal" is how a duplicate check starts accusing people at random.
 *
 * TEST ACCOUNTS ARE OUT OF IT, BOTH DIRECTIONS
 *
 * Callers pass only non-test candidates and skip the check entirely for a test
 * uploader. A room of testers deliberately passing one receipt around must not fill
 * the review queue, and a real BAM must never be flagged because a demo receipt from a
 * training session is sitting in the same table. Test data has no business deciding
 * anything about real money.
 *
 * THIS FLAGS, IT DOES NOT REJECT
 *
 * The result is a reason string for the review queue. There is a legitimate case that
 * looks exactly like the illegitimate one: two ambassadors at one event, one paying,
 * both submitting by mistake. A person decides. Refusing the upload would also tell
 * one BAM something about another BAM's submission, which is not theirs to know.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */

export type DuplicateCandidate = {
  id: string
  bamId: string
  /** Display name for the reason string. Falls back to a short id when absent. */
  bamName?: string | null
  period?: string | null
  sha256?: string | null
  store?: string | null
  date?: string | null
  grandTotal?: number | null
}

export type DuplicateSubject = {
  receiptId: string
  bamId: string
  sha256?: string | null
  store?: string | null
  date?: string | null
  grandTotal?: number | null
}

export type DuplicateMatch = {
  /** 'file' = identical bytes. 'content' = same store, date and total. */
  kind: 'file' | 'content'
  receiptId: string
  bamId: string
  reason: string
}

/** Store names are compared case- and whitespace-insensitively; nothing else is. */
function normStore(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}

function normDate(s: string | null | undefined): string {
  return String(s ?? '').trim()
}

/** Money compared at the cent, so 41.86 and 41.860001 are the same receipt. */
function sameMoney(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) < 0.005
}

function who(c: DuplicateCandidate): string {
  const name = String(c.bamName ?? '').trim()
  return name || `BAM ${c.bamId.slice(0, 8)}`
}

/**
 * The first candidate belonging to a different BAM that matches this receipt.
 *
 * Candidates from the SAME bamId are ignored: that case is already covered, by the
 * upload route for an identical file and by the OCR route's own history check for the
 * same content, and both produce better messages for it.
 *
 * The file signal is checked across every candidate before the content signal is
 * checked at all. When both are present the file match is the one worth reporting, and
 * reporting a weaker reason for a receipt that is provably the same bytes would send a
 * reviewer looking for a judgement call that is not there.
 */
export function findCrossBamDuplicate(
  subject: DuplicateSubject,
  candidates: readonly DuplicateCandidate[]
): DuplicateMatch | null {
  const others = candidates.filter(c => c.bamId !== subject.bamId && c.id !== subject.receiptId)

  const sha = String(subject.sha256 ?? '').trim()
  if (sha) {
    for (const c of others) {
      if (String(c.sha256 ?? '').trim() !== sha) continue
      return {
        kind: 'file',
        receiptId: c.id,
        bamId: c.bamId,
        reason:
          `duplicate_across_bams: this is the same image file already submitted by ${who(c)}` +
          `${c.period ? ` for ${c.period.slice(0, 7)}` : ''} (receipt ${c.id}). ` +
          'Two people cannot both be reimbursed for one purchase.'
      }
    }
  }

  const store = normStore(subject.store)
  const date = normDate(subject.date)
  // All three required. Matching on blanks would flag every unreadable receipt
  // against every other unreadable receipt.
  if (store && date && subject.grandTotal != null) {
    for (const c of others) {
      if (normStore(c.store) !== store) continue
      if (normDate(c.date) !== date) continue
      if (!sameMoney(c.grandTotal, subject.grandTotal)) continue
      return {
        kind: 'content',
        receiptId: c.id,
        bamId: c.bamId,
        reason:
          `duplicate_across_bams: same store, date and total as a receipt already submitted by ${who(c)}` +
          `${c.period ? ` for ${c.period.slice(0, 7)}` : ''} (receipt ${c.id}). ` +
          'The image differs, so this may be a second photo of one purchase. A human should confirm.'
      }
    }
  }

  return null
}
