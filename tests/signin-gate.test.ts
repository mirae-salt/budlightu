/**
 * Robin (super_admin) and Nathan (program_admin) could not sign in at all: the gate's
 * only check was BAM roster membership, and an administrator is not a student. It went
 * unnoticed because the one admin who had ever logged in also had a roster row.
 *
 * Administrators keep being added, so these cases are pinned rather than remembered.
 */
import { describe, it, expect } from 'vitest'
import { signInDecision, LOGIN_ALLOWED_STATUSES, type GateBamRow } from '../lib/signin-gate'
import { chooseTestCohort, type CohortChoice } from '../lib/admin-test-bam'

const row = (over: Partial<GateBamRow> = {}): GateBamRow => ({
  id: 'b1', auth_user_id: null, status: 'active', ...over
})

describe('signInDecision', () => {
  it('lets an admin in who is NOT on the roster (the Robin case)', () => {
    const d = signInDecision({ email: 'robin.graham@ilovesalt.com', isExistingAdmin: true, bamRows: [] })
    expect(d.allow).toBe(true)
    expect(d.allow && d.as).toBe('admin')
  })

  it('lets an admin in who IS also on the roster, still as admin', () => {
    const d = signInDecision({ email: 'mirae.lee@ilovesalt.com', isExistingAdmin: true, bamRows: [row()] })
    expect(d.allow && d.as).toBe('admin')
  })

  it('lets an admin in even when their test BAM row is archived', () => {
    // The admin claim is the reason they are allowed. A stale roster row must not
    // lock an administrator out of the admin dashboard.
    const d = signInDecision({ email: 'a@x.com', isExistingAdmin: true, bamRows: [row({ status: 'archived' })] })
    expect(d.allow && d.as).toBe('admin')
  })

  it('lets an active rostered BAM in', () => {
    const d = signInDecision({ email: 's@x.com', isExistingAdmin: false, bamRows: [row({ id: 'b9' })] })
    expect(d.allow).toBe(true)
    expect(d.allow && d.as === 'bam' && d.bam.id).toBe('b9')
  })

  it('lets a pending BAM in so they can finish onboarding', () => {
    const d = signInDecision({ email: 's@x.com', isExistingAdmin: false, bamRows: [row({ status: 'pending' })] })
    expect(d.allow && d.as).toBe('bam')
  })

  it('denies a non-participant with 404 and no hint about who is on the roster', () => {
    const d = signInDecision({ email: 'stranger@x.com', isExistingAdmin: false, bamRows: [] })
    expect(d.allow).toBe(false)
    expect(!d.allow && d.status).toBe(404)
    expect(!d.allow && d.reason).toBe('not_on_roster')
  })

  it('denies an archived BAM who is not an admin', () => {
    const d = signInDecision({ email: 'old@x.com', isExistingAdmin: false, bamRows: [row({ status: 'archived' })] })
    expect(!d.allow && d.status).toBe(403)
    expect(!d.allow && d.reason).toBe('status_not_allowed')
  })

  it('fails closed on an unknown status rather than allowing it', () => {
    const d = signInDecision({ email: 'x@x.com', isExistingAdmin: false, bamRows: [row({ status: 'suspended' })] })
    expect(d.allow).toBe(false)
  })

  it('denies duplicate roster rows instead of picking one', () => {
    const d = signInDecision({
      email: 'dup@x.com',
      isExistingAdmin: false,
      bamRows: [row({ id: 'a' }), row({ id: 'b' })]
    })
    expect(!d.allow && d.status).toBe(409)
    expect(!d.allow && d.reason).toBe('duplicate_roster')
  })

  it('allows exactly the statuses the DB check constraint permits, minus archived', () => {
    expect([...LOGIN_ALLOWED_STATUSES].sort()).toEqual(['active', 'pending'])
  })
})

describe('chooseTestCohort', () => {
  const c = (id: string, name: string | null): CohortChoice => ({ id, name })

  it('picks the cohort named TEST', () => {
    expect(chooseTestCohort([c('1', 'TEST'), c('2', 'Fall 2026')])?.id).toBe('1')
  })

  it('is case and whitespace insensitive', () => {
    expect(chooseTestCohort([c('1', '  test  ')])?.id).toBe('1')
  })

  it('returns null when there is no test cohort', () => {
    // Critical: a test BAM row in a LIVE cohort would be picked up by invoice
    // generation, producing an admin invoice addressed to AP with no banking data.
    expect(chooseTestCohort([c('1', 'Fall 2026'), c('2', 'Summer 2026')])).toBeNull()
  })

  it('returns null rather than guessing between two test cohorts', () => {
    expect(chooseTestCohort([c('1', 'TEST'), c('2', 'test 2027')])).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(chooseTestCohort([])).toBeNull()
  })

  it('does not match a live cohort that merely contains the word', () => {
    expect(chooseTestCohort([c('1', 'Greatest Hits 2026')])).toBeNull()
  })
})
