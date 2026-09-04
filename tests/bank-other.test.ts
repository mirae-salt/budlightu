/**
 * Onboarding with a bank that is not on our list.
 *
 * Janet, 2026-09-04: "Some BAMs' financial institutions are not listed in the portal.
 * Noah: Kawartha Credit Union. Emma Thompson: Your Credit Union. Could an 'Other'
 * option be added for unlisted banks?"
 *
 * The dropdown already offered "Other". The server then refused it, because lookupBank
 * returns null for anything unlisted and the caller hard-fails, so those two students
 * could not finish onboarding at all.
 *
 * No routing numbers were added for their credit unions. This file's subject is the
 * free-text path instead, and the reason is in lib/banks.ts: a seeded number nobody
 * verified is how nine of the original twenty-two entries came to be wrong.
 */
import { describe, it, expect } from 'vitest'
import { otherBankNameProblem, OTHER_BANK, lookupBank } from '../lib/banks'

describe('otherBankNameProblem', () => {
  it('accepts the two credit unions Janet named', () => {
    expect(otherBankNameProblem('Kawartha Credit Union')).toBeNull()
    expect(otherBankNameProblem('Your Credit Union')).toBeNull()
  })

  it('needs an actual name', () => {
    expect(otherBankNameProblem('')).toMatch(/enter your bank name/i)
    expect(otherBankNameProblem('   ')).toMatch(/enter your bank name/i)
    expect(otherBankNameProblem('a')).toMatch(/enter your bank name/i)
    expect(otherBankNameProblem(undefined)).toMatch(/enter your bank name/i)
    expect(otherBankNameProblem(null)).toMatch(/enter your bank name/i)
    expect(otherBankNameProblem(42)).toMatch(/enter your bank name/i)
  })

  it('rejects the literal word Other', () => {
    // Somebody typing "Other" into the box has answered nothing.
    expect(otherBankNameProblem('Other')).toMatch(/enter your bank name/i)
    expect(otherBankNameProblem('other')).toMatch(/enter your bank name/i)
  })

  it('sends a listed bank back to the dropdown', () => {
    /*
     * Typing "TD Canada Trust" as free text would skip the institution cross-check that
     * the dropdown entry gives them. The point of the free-text path is banks we cannot
     * check, not an opt-out from checking.
     */
    for (const name of ['TD Canada Trust', 'RBC Royal Bank', 'Meridian Credit Union', 'rbc']) {
      const problem = otherBankNameProblem(name)
      expect(problem).not.toBeNull()
      expect(problem).toMatch(/dropdown/i)
    }
  })

  it('refuses a name long enough to be a paragraph', () => {
    expect(otherBankNameProblem('x'.repeat(81))).toMatch(/too long/i)
    expect(otherBankNameProblem('x'.repeat(80))).toBeNull()
  })

  it('strips invisible characters before judging length', () => {
    // A pasted name carrying a zero-width space is still that name.
    expect(otherBankNameProblem('​Kawartha Credit Union​')).toBeNull()
    expect(otherBankNameProblem('​​')).toMatch(/enter your bank name/i)
  })
})

describe('the dropdown value itself', () => {
  it('is still not something lookupBank resolves', () => {
    // If this ever starts resolving, the server would take the branch that looks up a
    // table entry for a bank the student typed by hand.
    expect(lookupBank(OTHER_BANK)).toBeNull()
  })
})
