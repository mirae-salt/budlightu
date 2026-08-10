/**
 * /admin/unmatched used to clear the work item without doing the work: the
 * corrected email was never read, the write went through the anon key against a
 * super-admin-only table, and the page reported green unconditionally.
 *
 * These tests pin the part that decides WHICH roster row a submission belongs to.
 * Getting that wrong would point a correction at the wrong BAM, so every
 * ambiguous case must refuse rather than pick.
 */
import { describe, it, expect } from 'vitest'
import { MAX_REASON_LENGTH } from '../lib/reason'
import {
  rosterEmailFromFlagReason,
  resolveTargetBam,
  planUnmatchedResolution,
  parseRejectReason,
  type SubmissionRow,
  type BamCandidate
} from '../lib/unmatched-resolve'

const sub = (over: Partial<SubmissionRow> = {}): SubmissionRow => ({
  id: '11111111-1111-1111-1111-111111111111',
  matched_bam_id: null,
  flag_reason: 'email mismatch: form=typo@school.ca, roster=real@school.ca',
  submitted_email: 'typo@school.ca',
  ...over
})

const bam = (over: Partial<BamCandidate> = {}): BamCandidate => ({
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  email: 'real@school.ca',
  status: 'pending',
  ...over
})

describe('rosterEmailFromFlagReason', () => {
  it('reads the roster address onboarding-ingest recorded', () => {
    expect(rosterEmailFromFlagReason('email mismatch: form=a@b.ca, roster=c@d.ca')).toBe('c@d.ca')
  })

  it('normalizes case and invisible characters the same way login does', () => {
    // A BOM inside the fragment must not produce a different key than the one the
    // roster lookup uses (ENGINEERING-RULES 7.6). Built from the code point so
    // the assertion cannot quietly become vacuous.
    const bom = String.fromCodePoint(0xfeff)
    expect(rosterEmailFromFlagReason(`roster=${bom}Real@School.CA`)).toBe('real@school.ca')
  })

  it('returns null when there is no fragment to read', () => {
    expect(rosterEmailFromFlagReason('no matching roster email')).toBeNull()
    expect(rosterEmailFromFlagReason(null)).toBeNull()
    expect(rosterEmailFromFlagReason(undefined)).toBeNull()
  })
})

describe('resolveTargetBam', () => {
  it('prefers an existing matched_bam_id link', () => {
    const s = sub({ matched_bam_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })
    const r = resolveTargetBam(s, [bam({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.via).toBe('matched_bam_id')
  })

  it('refuses when the linked roster row is gone', () => {
    const r = resolveTargetBam(sub({ matched_bam_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }), [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(404)
  })

  it('resolves via the roster= fragment when exactly one row matches', () => {
    const r = resolveTargetBam(sub(), [bam(), bam({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', email: 'someone@else.ca' })])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.via).toBe('flag_reason')
      expect(r.bam.id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    }
  })

  it('REFUSES when two roster rows share the roster email (ambiguous target)', () => {
    // Reachable in practice: the unique index is on lower(email), so
    // "re al@school.ca" and "real@school.ca" are two rows that normalize to one
    // address. Picking either one would be a coin flip on somebody's pay.
    const r = resolveTargetBam(sub(), [
      bam(),
      bam({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', email: 're al@school.ca' })
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(409)
      expect(r.message).toContain('ambiguous')
    }
  })

  it('refuses when no roster row carries that email', () => {
    const r = resolveTargetBam(sub(), [bam({ email: 'different@school.ca' })])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(404)
  })

  it('refuses when flag_reason records no roster email at all', () => {
    const r = resolveTargetBam(sub({ flag_reason: 'parked by hand' }), [bam()])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(409)
  })
})

describe('planUnmatchedResolution', () => {
  it('plans the email change for a pending BAM', () => {
    const plan = planUnmatchedResolution({
      submission: sub(),
      candidates: [bam()],
      correctedEmail: '  TYPO@school.ca '
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      // Normalized on write, not just on read (P1-6).
      expect(plan.emailChange).toEqual({ from: 'real@school.ca', to: 'typo@school.ca' })
      expect(plan.correctedEmail).toBe('typo@school.ca')
    }
  })

  it('rejects an invalid corrected email before any lookup', () => {
    const plan = planUnmatchedResolution({
      submission: sub(),
      candidates: [bam()],
      correctedEmail: 'not-an-email'
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.status).toBe(400)
  })

  it('rejects an empty corrected email (the old UI enabled Save on a dash)', () => {
    for (const value of ['', '   ', '—', undefined, null]) {
      const plan = planUnmatchedResolution({ submission: sub(), candidates: [bam()], correctedEmail: value })
      expect(plan.ok).toBe(false)
    }
  })

  it('needs no roster write when the roster already holds the corrected address', () => {
    const plan = planUnmatchedResolution({
      submission: sub(),
      candidates: [bam()],
      correctedEmail: 'real@school.ca'
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.emailChange).toBeNull()
  })

  it('will not change the email of a BAM who already onboarded', () => {
    const plan = planUnmatchedResolution({
      submission: sub(),
      candidates: [bam({ status: 'active' })],
      correctedEmail: 'typo@school.ca'
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.status).toBe(409)
  })

  it('still lets a stale submission be closed against an active BAM', () => {
    const plan = planUnmatchedResolution({
      submission: sub(),
      candidates: [bam({ status: 'active' })],
      correctedEmail: 'real@school.ca'
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.emailChange).toBeNull()
  })

  it('refuses an archived target', () => {
    const plan = planUnmatchedResolution({
      submission: sub(),
      candidates: [bam({ status: 'archived' })],
      correctedEmail: 'real@school.ca'
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.status).toBe(409)
  })
})

describe('parseRejectReason', () => {
  it('requires a reason', () => {
    expect(parseRejectReason(undefined).ok).toBe(false)
    expect(parseRejectReason('').ok).toBe(false)
    expect(parseRejectReason('no').ok).toBe(false)
  })

  it('collapses whitespace and accepts a real reason', () => {
    const r = parseRejectReason('  not a   BAM in this cohort ')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.reason).toBe('not a BAM in this cohort')
  })

  it('caps the length, using the shared limit rather than its own', () => {
    // Was a local 300. Every reason field now shares lib/reason.ts, so the same
    // text is accepted or refused identically on every screen.
    expect(parseRejectReason('x'.repeat(MAX_REASON_LENGTH)).ok).toBe(true)
    expect(parseRejectReason('x'.repeat(MAX_REASON_LENGTH + 1)).ok).toBe(false)
  })
})
