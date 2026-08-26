/**
 * A row that lands in a TEST cohort is a test row.
 *
 * The pairing rule already refused a test row in a live cohort. This is the other
 * direction, and it exists because the "Test account" checkbox defaults to off: picking
 * the TEST cohort and forgetting the tick produced a row that reads as a tester and is
 * treated as a real BAM by everything that matters.
 *
 * The concrete failure was a live testing session on 2026-08-26. An unticked tester
 * cannot upload a receipt after the 15th, because lib/period.ts keys its deadline
 * exception off is_test, so the session would have failed at the one step it was for.
 */
import { describe, it, expect } from 'vitest'
import { isTestForCohort, testRowCohortProblem, isTestCohortName } from '../lib/admin-test-bam'

describe('landing in a TEST cohort sets the flag', () => {
  it('promotes an unticked row', () => {
    expect(isTestForCohort('TEST', false)).toBe(true)
  })

  it('accepts the same names isTestCohortName accepts', () => {
    for (const name of ['TEST', 'test', ' Test ', 'TEST cohort', 'Fall 2026 test']) {
      expect(isTestForCohort(name, false)).toBe(true)
      expect(isTestCohortName(name)).toBe(true)
    }
  })

  it('leaves a real cohort alone', () => {
    for (const name of ['Fall 2026', 'Summer 2026', 'Contest', 'Latest']) {
      expect(isTestForCohort(name, false)).toBe(false)
    }
  })
})

describe('it only tightens, never loosens', () => {
  it('keeps an already-test row test when the cohort is unknown', () => {
    // Tightening is automatic. Loosening has to be deliberate, because turning a test row
    // into a real BAM is how one gets a real invoice addressed to AP.
    expect(isTestForCohort(null, true)).toBe(true)
    expect(isTestForCohort(undefined, true)).toBe(true)
    expect(isTestForCohort('Fall 2026', true)).toBe(true)
  })

  it('does not clear the flag when moving to a live cohort, so the guard still fires', () => {
    const stillTest = isTestForCohort('Fall 2026', true)
    expect(stillTest).toBe(true)
    // And that is exactly what makes the move refuse rather than silently succeed.
    const problem = testRowCohortProblem({
      isTest: stillTest,
      cohortName: 'Fall 2026',
      cohortFound: true
    })
    expect(problem).not.toBe(null)
  })
})

describe('the two rules agree', () => {
  it('a promoted row never trips the guard it just passed through', () => {
    const resolved = isTestForCohort('TEST', false)
    expect(testRowCohortProblem({ isTest: resolved, cohortName: 'TEST', cohortFound: true })).toBe(null)
  })

  it('an unreadable cohort does not silently promote', () => {
    // cohortFound false is handled by testRowCohortProblem, which refuses. This function
    // must not invent a true that would make that refusal look like a real test row.
    expect(isTestForCohort(null, false)).toBe(false)
  })
})
