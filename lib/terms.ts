/**
 * The program terms BAMs agree to, and the version stamped on their acceptance.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The onboarding form has a checkbox reading "I agree to the Bud Light U program
 * terms", and `bams.consent_terms_at` / `consent_terms_version` record the
 * acceptance. But there was nothing to read: no page, no document, no text anywhere
 * in the app. A student was agreeing to terms that did not exist as a readable thing,
 * which makes the recorded consent close to meaningless.
 *
 * The version was also written in two places (`app/api/onboarding/complete` and
 * `supabase/functions/onboarding-ingest`), which happened to agree. Two copies of a
 * version string agree right up until someone edits one, and then old acceptances
 * become indistinguishable from new ones. Both now import from here.
 *
 * ROBIN OWNS THE WORDING. She is drafting the real terms; this file holds what the
 * SYSTEM ACTUALLY ENFORCES so her draft has something factual to sit against and
 * nothing here contradicts the code. Each clause below cites where it is enforced.
 * Sections marked `draft: true` are placeholders and are rendered as such — they are
 * not presented to students as settled policy.
 *
 * WHEN THE REAL COPY LANDS
 * 1. Replace the section bodies.
 * 2. Bump TERMS_VERSION. Do NOT edit the wording without bumping it, or a later
 *    revision silently reinterprets what an earlier student agreed to.
 * 3. Anyone who accepted an older version keeps that older version on their row.
 */

/**
 * Stamped on `bams.consent_terms_version` at acceptance. Date-based so an acceptance
 * can be read against the wording that was live at the time.
 *
 * Bump this whenever the text below changes in a way that affects what someone is
 * agreeing to. Fixing a typo does not need a bump; changing a rule does.
 */
export const TERMS_VERSION = '2026-09-02'

/**
 * Why this looks like it went backwards.
 *
 * The previous value was '2026-09-01', named after the program start rather than the
 * day the wording landed. This one follows the convention stated above: the date the
 * text became live, so an acceptance can be read against what was on screen at the
 * time. The labels are identifiers, not an ordering.
 *
 * Bumped on 2026-08-12 because the Receipts and Reimbursement sections changed what a
 * student is agreeing to, not just how it is phrased:
 *   - a month now runs the 16th to the 15th, so a purchase on the 20th falls in the
 *     next month rather than the one it was made in
 *   - a closed month is refused outright, where the old text said a late receipt "may
 *     not be reimbursed for that month"
 *
 * Bumped again on 2026-08-14, for two changes made the same day:
 *   - the "Conduct and brand" and "Ending your participation" draft sections are removed,
 *     not filled in (Robin's call -- see the comment where they used to sit). A student
 *     accepting this version agrees to a page that no longer mentions those topics.
 *   - Robin's own wording landed for the four financial sections, replacing ours. It is
 *     not a paraphrase: the pay figures are now stated literally, spending $150 is
 *     described as a requirement rather than a maximum, and the "counted generously"
 *     deadline promise is gone.
 * Both are the same day, so one version covers them. Nobody has accepted '2026-08-14'
 * yet, so there is no acceptance stranded between the two edits.
 *
 * Per rule 3 above, the one row holding '2026-09-01' keeps it. It is a test account.
 *
 * Bumped again on 2026-09-02: "Your invoices" now opens with the student authorising
 * Bud Light U to submit invoices to accounts payable on their behalf. That is new
 * authority, not a rewording, and it is the gap Robin raised in Teams on 2026-08-27.
 * Timing is deliberate. Three real students have accepted a prior version; the other
 * 57 are still `pending` and will accept this one at onboarding, so almost nobody
 * ends up holding the version that never asked.
 */

export type TermsSection = {
  heading: string
  /** Paragraphs. Plain strings: this is rendered as text, never as HTML. */
  body: string[]
  /**
   * Where in the code this is enforced. Shown to nobody — it exists so the next
   * person to edit the wording can check whether the system still does this.
   */
  enforcedAt?: string
  /** True when this is a placeholder awaiting Robin's copy, not settled wording. */
  draft?: boolean
}

export const TERMS_SECTIONS: readonly TermsSection[] = [
  /*
   * The four sections below are ROBIN'S WORDING, sent 2026-08-14 after the BL Campus x AI
   * Final Connect meeting ("I'll send you the terms and conditions edits... some of the
   * headings I changed a little bit"). Pasted as received. Do not reword them to match how
   * the code describes itself: where the two differ, that is a question for Robin, not a
   * copy edit. The `enforcedAt` notes below flag the two places they currently differ.
   */
  {
    heading: 'Payment Details',
    body: [
      'You are paid $1,750 across the entire 8-month program. This will be paid out in $218.75 monthly payments.',
      'Payment is by direct deposit on net-15 terms, to the banking details on your account.'
    ],
    // NOTE: Robin's copy states the figures literally, while the system reads them from
    // cohorts.salary_default per cohort. They agree for Fall 2026 ($218.75 x 8 = $1,750).
    // A cohort with a different salary or term length would make this page wrong, so this
    // wording is worth revisiting when a second live cohort is created.
    enforcedAt: 'cohorts.salary_default; lib/invoice-payload.ts salaryLine'
  },
  {
    heading: 'Bud Light Product Reimbursement',
    body: [
      'Each month, BAMs are required to spend at least $150 on Bud Light product and will be reimbursed for up to $150 of their total spend.',
      'Receipts must be submitted by the 15th of each month to receive that month’s reimbursement. So for September, BAMs must submit their $150 worth of product receipts by September 15th in order to be reimbursed for the month.',
      'Only Bud Light products count. If a receipt includes other items, only the Bud Light will be reimbursed.',
      'The monthly maximum does not carry over. Anything unspent in a month does not increase the next month.'
    ],
    enforcedAt: 'cohorts.reimbursement_max; rollover_mode = forfeit; lib/reimbursement.ts'
  },
  {
    heading: 'Receipts',
    body: [
      'Submit your receipts through the portal by the 15th of the month.',
      'After that the month is closed and the portal will not accept receipts for it. If you miss the deadline, contact your program manager rather than submitting it against another month.',
      'You may submit more than one receipt per month.',
      'Receipts are reviewed. Where a receipt is unclear, your program manager will manually review.',
      'Keep your original receipts for at least six months. You may be asked for them.',
      'Submitting a receipt that is fraudulent, altered, reused, or generated by AI may result in losing that month’s reimbursement and being removed from the program.'
    ],
    // NOTE: Robin's copy drops the old "counted generously" sentence. The generosity is
    // still real (lib/deadline.ts holds the cutoff at 08:00 UTC on the 16th, so a late
    // Pacific submission on the 15th is on time). It just is not promised in writing now,
    // which is the safer direction: the page states the earlier deadline, the system is
    // quietly kinder than the page.
    enforcedAt: 'lib/period.ts validatePeriod; lib/deadline.ts; app/api/admin/receipts/decide'
  },
  {
    heading: 'Underspend',
    body: [
      'If your spending in a month is below the program’s expectation, you may get a warning email letting you know that you have not met the month’s contractual requirement.',
      'If that happens two months in a row, your program manager will review your participation with you. This is a conversation, not necessarily an automatic removal.'
    ],
    enforcedAt: 'lib/policy.ts SHORTFALL_WARN_BELOW_CAD ($130); lib/shortfall-warning.ts consecutiveWarningStreak'
  },
  {
    heading: 'Your banking details',
    body: [
      'You enter your banking details once, yourself, when you first set up your account. Nobody else types them in for you.',
      'They are stored encrypted and are used only to pay you.',
      'To change them later, request the change in the portal. A program manager has to approve it before it takes effect, and you will be asked to confirm the last digits of the new account. This is deliberate: it is what stops someone else redirecting your pay.'
    ],
    enforcedAt: 'encrypt_bam_banking (service role only, migration 0024); app/api/portal/banking-request; app/api/admin/banking-requests/decide'
  },
  {
    heading: 'Your invoices',
    body: [
      /*
       * Robin, Teams, 2026-08-27: "Maybe we could add a terms and conditions pop up to
       * the portal that they need to agree to outlining that they give permission for
       * the portal to submit invoices on behalf of them."
       *
       * This is the authority the signed BAM contract does not grant. That contract says
       * "Brand Activation Manager shall submit a written invoice to Company", and this
       * system prepares the invoice and sends it to accounts payable without the student
       * touching it. Nothing in the app asked them to agree to that until now.
       *
       * It goes first in the section because it is the sentence that matters. Robin also
       * asked whether the 57 signed contracts need re-signing: they do not, because every
       * one of those students is still `pending` and accepts this at onboarding.
       */
      'You authorise Bud Light U to prepare your monthly invoices and submit them to accounts payable on your behalf. You do not send them yourself.',
      'Invoices are built from your roster record and your approved receipts. You cannot change the amounts, the invoice number, or the dates.',
      'You can see your invoices in the portal and have a copy emailed to yourself.',
      'If something on an invoice looks wrong, contact your program manager rather than trying to correct it yourself.'
    ],
    enforcedAt: 'lib/invoice-payload.ts (system-generated); app/api/admin/send-ap; app/api/portal/invoices/*'
  },
  {
    heading: 'Your information',
    body: [
      'The program stores your name, contact details, school, mailing address, and banking details so it can pay you.',
      'Your banking details are encrypted. Other BAMs cannot see your information.'
    ],
    enforcedAt: 'RLS policies in supabase/migrations/0002, 0012, 0016; pgp_sym_encrypt in 0003'
  }
  /*
   * "Conduct and brand" and "Ending your participation" were here as draft placeholders
   * and are gone, not filled in. Robin, 2026-08-14 (BL Campus x AI Final Connect): "I
   * redrafted some of the paragraphs, the ones at the bottom, the conduct and brand, and
   * then the ending your participation piece -- I think we can honestly leave out of this
   * platform... they've all signed their contracts, they all will sign like codes of
   * conduct... I think if we keep this just financial, that's totally fine." Those topics
   * are covered by the BAM's employment contract and code of conduct, not this page.
   */
]

/** True when any section is still a placeholder, so the page can say so honestly. */
export const TERMS_HAS_DRAFT_SECTIONS = TERMS_SECTIONS.some(s => s.draft === true)
