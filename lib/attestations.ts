/**
 * Three statements a contractor makes at setup, and the wording they made them against.
 *
 * From Shane Deen's 2026-08-27 worker-classification review (items B, E and F). The
 * point of each is not the sentence on screen, it is the row afterwards: "this person,
 * on this date, agreed to this wording". A checkbox nobody records is decoration.
 *
 * Same shape as lib/hst-declaration.ts, which is the same shape as TERMS_VERSION. Every
 * string here is text somebody ticks a box against, so it lives in one file as
 * constants: when whoever owns Salt's contractor agreements revises it, that is one edit
 * and a version bump, not a hunt through two page components and an Edge Function.
 *
 * WHY THESE THREE AND NOT SHANE'S WHOLE LIST
 *
 * B (work authorization) and E (banking ownership) are new statements that nothing else
 * in the system or the signed contract collects. F (automated processing) is a
 * disclosure Quebec makes load-bearing: Robin confirmed 8 BAMs at Quebec schools, so
 * Law 25 s.12.1 is in play rather than hypothetical.
 *
 * C (a per-upload receipt attestation) is deliberately absent. The program terms already
 * cover fraudulent, altered and reused receipts, and asking again on every upload is 58
 * students x 8 months of clicking for a statement they have already made.
 *
 * D (an invoice review and approve screen) is not here because it is not copy. It is a
 * flow, and it collides with the rule that a BAM never edits an invoice. The one piece
 * of D that could be settled with wording, authorising Salt to send the invoice to AP,
 * went into the program terms on 2026-09-02 instead.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */

/** Bump when any user-visible string below changes. Stored per BAM, so an old row is
 *  never silently reinterpreted under new wording. */
export const ATTESTATION_VERSION = '2026-09-02'

export const WORK_AUTH_COPY = {
  heading: 'Your right to work',
  /*
   * Shane called this "your highest-value new attestation", and the signed BAM contract
   * has nothing on the subject: no "permit", no "legally entitled", no work
   * authorization clause anywhere in it (checked against the PDF, 2026-09-02).
   *
   * The second sentence is the one that matters. A study permit's off-campus work
   * allowance generally does not extend to self-employment, and these students are paid
   * as independent contractors. Somebody can tick the first half honestly and still be
   * wrong, so the specific case is named.
   */
  checkbox:
    'I am legally entitled to do self-employed contractor work in Canada. ' +
    'If I hold a study or work permit, my permit allows self-employment.',
  help:
    'Not sure? Leave this unticked and ask your program contact. ' +
    'Off-campus work rules for study permits usually do not cover self-employment.'
} as const

export const BANKING_ATTESTATION_COPY = {
  /*
   * Short because it sits directly under the account fields, where the context is
   * already on screen. This is the statement that makes a wrong account the payee's
   * problem rather than an open question.
   */
  checkbox:
    'This account is in my name or my business name, and I am authorised to be paid into it.'
} as const

export const AI_DISCLOSURE_COPY = {
  heading: 'How we use automated tools',
  /*
   * PIPEDA, and Quebec Law 25 s.12.1, which gives a person the right to be told when a
   * decision about them is made by automated means and to ask for a human to look at it.
   * Robin confirmed 8 BAMs at Quebec schools on 2026-08-27.
   *
   * It says what is true of this system rather than what a template would say: a receipt
   * is read by a model, a person decides anything the model flags, and nothing is paid
   * without Robin approving the batch.
   */
  body: [
    'We use automated tools to read your receipts and prepare your invoice drafts.',
    'A person reviews anything the tools flag, and no payment goes out without a program manager approving it.',
    'You can ask how a receipt was assessed, and ask a person to look at it again.'
  ],
  /*
   * A SEPARATE tick, not folded into the program terms. Shane: "bundling it into general
   * T&Cs won't meet the meaningful-consent standard." Meaningful consent has to be
   * refusable, so this one is optional and a "no" is recorded as a no rather than as
   * silence.
   */
  trainingCheckbox:
    'Optional: you may use my support messages to improve the help content and automated replies.',
  trainingHelp:
    'You can say no. It changes nothing about your pay, your receipts, or your invoices.'
} as const

export type AttestationInput = {
  workAuth?: unknown
  bankingOwner?: unknown
  aiTraining?: unknown
}

export type AttestationResult =
  | {
      ok: true
      /** Timestamp columns are set only when the box was actually ticked. */
      workAuthAttested: boolean
      bankingOwnerAttested: boolean
      /** true, false or null. null means the question was never put to them. */
      aiTraining: boolean | null
    }
  | { ok: false; error: string }

/**
 * Validates the three answers.
 *
 * The two required ones must be literally `true`. A missing field is refused rather
 * than read as false, because "they did not tick it" and "the form did not send it"
 * are different failures and only one of them is the student's.
 */
export function validateAttestations(input: AttestationInput): AttestationResult {
  if (input.workAuth !== true) {
    return { ok: false, error: 'Confirm you are legally entitled to do contractor work in Canada.' }
  }
  if (input.bankingOwner !== true) {
    return { ok: false, error: 'Confirm the bank account is in your name.' }
  }

  // Optional. Absent means never asked; present means they answered one way or the other.
  let aiTraining: boolean | null = null
  if (input.aiTraining === true) aiTraining = true
  else if (input.aiTraining === false) aiTraining = false

  return { ok: true, workAuthAttested: true, bankingOwnerAttested: true, aiTraining }
}
