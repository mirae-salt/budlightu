/**
 * Where a test account is allowed to sit.
 *
 * Three routes can put a BAM in a cohort and on 2026-08-13 only one of them checked, so this
 * pins the rule rather than the call sites. `is_test` does not stop invoice generation, so a
 * test row in a live cohort gets a real invoice addressed to AP.
 */
import { describe, it, expect } from 'vitest'
import { isTestCohortName, testRowCohortProblem } from '../lib/admin-test-bam'

describe('isTestCohortName', () => {
  it('accepts the names a test cohort actually has', () => {
    expect(isTestCohortName('TEST')).toBe(true)
    expect(isTestCohortName('test')).toBe(true)
    expect(isTestCohortName('  Test  ')).toBe(true)
    expect(isTestCohortName('TEST 2026')).toBe(true)
    expect(isTestCohortName('Fall 2026 test')).toBe(true)
  })

  it('does not accept a live cohort that merely contains the letters', () => {
    expect(isTestCohortName('Fall 2026')).toBe(false)
    expect(isTestCohortName('Contest 2026')).toBe(false)
    expect(isTestCohortName('Latest cohort')).toBe(false)
    expect(isTestCohortName(null)).toBe(false)
  })
})

describe('testRowCohortProblem', () => {
  it('never blocks a real BAM, in any cohort', () => {
    expect(testRowCohortProblem({ isTest: false, cohortName: 'Fall 2026', cohortFound: true })).toBeNull()
    expect(testRowCohortProblem({ isTest: false, cohortName: 'TEST', cohortFound: true })).toBeNull()
    // Even when the cohort could not be read: a real BAM moving is not a money risk, and
    // failing that closed would block the September cutover for no reason.
    expect(testRowCohortProblem({ isTest: false, cohortName: null, cohortFound: false })).toBeNull()
  })

  it('allows a test row in a test cohort', () => {
    expect(testRowCohortProblem({ isTest: true, cohortName: 'TEST', cohortFound: true })).toBeNull()
  })

  it('refuses a test row in a live cohort', () => {
    const problem = testRowCohortProblem({ isTest: true, cohortName: 'Fall 2026', cohortFound: true })
    expect(problem).toBeTruthy()
    // Names the cohort, so the admin knows which move was refused.
    expect(problem).toContain('Fall 2026')
    // Says what to do instead. A refusal with no way forward gets worked around.
    expect(problem).toContain('TEST')
  })

  it('FAILS CLOSED when the cohort cannot be read', () => {
    // This is audit finding 20. The old code was `if (target && !isTestCohortName(...))`, so a
    // cohort that came back as zero rows skipped the check. "I could not check" is not "fine".
    const problem = testRowCohortProblem({ isTest: true, cohortName: null, cohortFound: false })
    expect(problem).toBeTruthy()
    expect(problem).toContain('could not be read')
  })
})
