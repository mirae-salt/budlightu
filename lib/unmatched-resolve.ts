/**
 * Deciding WHICH roster row a parked onboarding submission belongs to, and what
 * the safe correction is. Pure so it can be unit-tested without a database and
 * imported by the admin page for display.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * /admin/unmatched "Fix roster" used to read the admin's corrected email, throw
 * it away, and set `status:'resolved'` with the browser anon key. Three failures
 * stacked: `onboarding_submissions` is super-admin-only under RLS
 * (0002_rls_policies.sql), so for a program_admin the UPDATE matched zero rows;
 * neither `error` nor the row count was checked; and the page reported a green
 * "Roster updated" regardless. Net effect: the student stayed locked out of
 * login, receipt upload and payment, and the only record that anyone had to act
 * on vanished from the queue.
 *
 * ── The chosen resolution ────────────────────────────────────────────────────
 * A parked submission means: the student opened a valid invite link (so the
 * server already knows exactly which pending BAM the link was minted for) and
 * then typed an email that did not equal the roster email. onboarding-ingest
 * records that as `flag_reason = "email mismatch: form=<x>, roster=<y>"`.
 *
 * So the target BAM is derived SERVER-SIDE from `matched_bam_id` or from the
 * `roster=` fragment. The client cannot name a BAM at all: the request body
 * carries only `submission_id` and `corrected_email`. That is what makes it
 * impossible to point a submission at the wrong BAM. If neither source yields
 * exactly one roster row, we refuse and say why instead of guessing.
 *
 * The correction itself writes `bams.email = corrected_email` (the address the
 * student actually uses) for a PENDING BAM, which is the thing that unblocks
 * them: their invite token is still stored, so the same link now matches.
 *
 * For a BAM that is already `active` we refuse to change the email here. They
 * have a Supabase Auth user, and an email change for them is a roster operation
 * with its own audited path (PATCH /api/admin/roster). A stale parked row can
 * still be cleared: submit the address that is already on the roster and the
 * plan becomes link-and-resolve with no write to `bams`.
 */
import { normalizeEmail, parseEmail } from './sanitize'
import { reasonProblem } from './reason'

/** Written by supabase/functions/onboarding-ingest: "...form=<a>, roster=<b>". */
export const ROSTER_EMAIL_RE = /roster\s*=\s*([^\s,;]+)/i

export type SubmissionRow = {
  id: string
  matched_bam_id: string | null
  flag_reason: string | null
  submitted_email: string | null
}

/** Only the columns needed to decide. Never banking, never address. */
export type BamCandidate = {
  id: string
  email: string | null
  status: string
}

export type ResolutionPlan =
  | { ok: false; status: 400 | 404 | 409; message: string }
  | {
      ok: true
      bamId: string
      via: 'matched_bam_id' | 'flag_reason'
      /** null when the roster already holds the corrected address. */
      emailChange: { from: string; to: string } | null
      correctedEmail: string
    }

/**
 * The roster email onboarding-ingest could not match, in canonical form.
 * Returns null when flag_reason has no usable fragment (a hand-written reason,
 * or a submission parked by some future code path).
 */
export function rosterEmailFromFlagReason(flagReason: string | null | undefined): string | null {
  if (typeof flagReason !== 'string') return null
  const m = ROSTER_EMAIL_RE.exec(flagReason)
  if (!m) return null
  const email = normalizeEmail(m[1])
  return email || null
}

/**
 * Narrow a set of roster rows down to the one target, or refuse.
 * `candidates` is whatever the caller looked up; this function does the deciding
 * so the rules are testable and identical everywhere.
 */
export function resolveTargetBam(
  submission: SubmissionRow,
  candidates: BamCandidate[]
): { ok: true; bam: BamCandidate; via: 'matched_bam_id' | 'flag_reason' } | { ok: false; status: 404 | 409; message: string } {
  if (submission.matched_bam_id) {
    const linked = candidates.find(c => c.id === submission.matched_bam_id)
    if (!linked) {
      return {
        ok: false,
        status: 404,
        message: 'This submission is linked to a roster row that no longer exists. Fix the roster entry first.'
      }
    }
    return { ok: true, bam: linked, via: 'matched_bam_id' }
  }

  const rosterEmail = rosterEmailFromFlagReason(submission.flag_reason)
  if (!rosterEmail) {
    return {
      ok: false,
      status: 409,
      message: 'Cannot tell which roster row this submission was for: its reason does not record a roster email. Resolve it from the roster page instead.'
    }
  }

  const matches = candidates.filter(c => normalizeEmail(c.email) === rosterEmail)
  if (matches.length === 0) {
    return {
      ok: false,
      status: 404,
      message: `No roster row has the email this submission failed to match (${rosterEmail}). It may have been edited or archived. Resolve it from the roster page instead.`
    }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      status: 409,
      message: `${matches.length} roster rows share the email ${rosterEmail}, so the target is ambiguous. De-duplicate the roster first.`
    }
  }
  return { ok: true, bam: matches[0], via: 'flag_reason' }
}

/**
 * Full plan: target + whether a roster email write is needed and allowed.
 * The caller executes it and checks `error` plus rows-affected on every write.
 */
export function planUnmatchedResolution(input: {
  submission: SubmissionRow
  candidates: BamCandidate[]
  correctedEmail: unknown
}): ResolutionPlan {
  const parsed = parseEmail(input.correctedEmail)
  if (!parsed.ok) return { ok: false, status: 400, message: parsed.reason }

  const target = resolveTargetBam(input.submission, input.candidates)
  if (!target.ok) return target

  const current = normalizeEmail(target.bam.email)
  const needsChange = current !== parsed.email

  if (target.bam.status === 'archived') {
    return {
      ok: false,
      status: 409,
      message: 'That roster row is archived. Reactivate it on the roster page before resolving this submission.'
    }
  }

  if (needsChange && target.bam.status !== 'pending') {
    return {
      ok: false,
      status: 409,
      message: 'That BAM has already finished onboarding, so their email is not changed from this queue. Change it on the roster page, then resolve this submission with the address the roster holds.'
    }
  }

  return {
    ok: true,
    bamId: target.bam.id,
    via: target.via,
    emailChange: needsChange ? { from: current, to: parsed.email } : null,
    correctedEmail: parsed.email
  }
}

/** Reject needs a real reason: "rejected" with no explanation is not a record. */
export function parseRejectReason(raw: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: 'A reason is required to reject a submission.' }
  const reason = raw.replace(/\s+/g, ' ').trim()
  // Shared rule (lib/reason.ts) so the same words are accepted on every screen.
  const issue = reasonProblem(reason, 'A reason for rejecting')
  if (issue) return { ok: false, message: issue }
  return { ok: true, reason }
}
