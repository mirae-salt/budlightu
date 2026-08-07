/**
 * Gate for CC'ing a BAM on their own AP invoice email (F4, critic gate 2026-08-07).
 *
 * WHAT WAS BROKEN
 * ---------------
 * Both AP senders pushed `bam.email` onto the CC list after nothing but a format
 * check:
 *   app/api/admin/send-ap/route.ts:130-133
 *   supabase/functions/sendApEmail/index.ts:75-78
 * Meanwhile app/api/admin/send-bam-copy/route.ts:80 HARD BLOCKS when
 * `email_verified_at` is NULL, precisely so a typo'd roster address cannot
 * receive invoice contents (that is control P0-4). The AP CC path walked around
 * it, and `consent_ap_cc` — collected at onboarding-ingest:192 — was never read
 * by anything.
 *
 * The invoice PDF contains the BAM's home address, bank name, institution
 * number, transit number and account number. One transposed character in a
 * roster email address mails all of that to a stranger.
 *
 * THE RULE
 * --------
 * CC the BAM only when BOTH are true:
 *   - `email_verified_at` is set (they have completed an OTP login, so the
 *     address provably reaches them), and
 *   - `consent_ap_cc` is true (they asked to be copied).
 * Robin keeps the feature; it is gated, not removed.
 *
 * Returns null when the CC is allowed, or a human-readable reason when it is not.
 * The reason is reported as a warning on the send result — it never blocks the
 * AP email itself, because AP still has to be paid.
 */

export type BamCcFields = {
  email?: string | null
  email_verified_at?: string | null
  consent_ap_cc?: boolean | null
}

export function bamCcProblem(bam: BamCcFields | null | undefined): string | null {
  if (!bam) return 'no BAM record — not CC-ing anyone'
  if (!bam.email) return 'BAM has no email on file — not CC-ing them on the AP email'
  if (!bam.email_verified_at) {
    return (
      'BAM not CC\'d: bams.email_verified_at is NULL. The student has not completed an OTP login, ' +
      'so the address is unverified and the invoice PDF contains their bank details (P0-4).'
    )
  }
  if (bam.consent_ap_cc !== true) {
    return 'BAM not CC\'d: bams.consent_ap_cc is not set. They did not opt in to being copied on the AP email.'
  }
  return null
}
