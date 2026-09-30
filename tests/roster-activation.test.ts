/**
 * An admin edit that makes a student payable has to open their invoice.
 *
 * Lea Major (2026-09) joined on the 2nd, uploaded two receipts while still pending, and had
 * no invoice because the only two places that create one are the monthly job on the 1st and
 * the end of onboarding. These cover the decision to ask for one after a roster edit, the
 * guard that an existing invoice is never rewritten, and what the admin is told.
 */
import { describe, it, expect, vi } from 'vitest'
import { missingConfirmations, shouldSeedAfterEdit, seedIfMissing } from '../lib/roster-activation'

describe('missingConfirmations', () => {
  it('lists everything for a student who confirmed nothing, as Lea Major had', () => {
    expect(missingConfirmations({})).toEqual(['email verification', 'terms', 'work authorization', 'banking confirmation'])
    expect(missingConfirmations(null)).toHaveLength(4)
  })

  it('lists only what is still missing', () => {
    expect(missingConfirmations({
      email_verified_at: '2026-09-02T00:00:00Z',
      consent_terms_at: '2026-09-02T00:00:00Z',
      work_auth_attested_at: null,
      banking_attested_at: '2026-09-02T00:00:00Z'
    })).toEqual(['work authorization'])
  })

  it('is empty once everything is given', () => {
    const t = '2026-09-02T00:00:00Z'
    expect(missingConfirmations({ email_verified_at: t, consent_terms_at: t, work_auth_attested_at: t, banking_attested_at: t })).toEqual([])
  })
})

describe('shouldSeedAfterEdit', () => {
  it('asks when a student becomes active', () => {
    expect(shouldSeedAfterEdit({ beforeStatus: 'pending', afterStatus: 'active', isTest: false, changedKeys: ['status'] })).toBe(true)
  })

  it('asks when an active student gets an address, because the monthly job skipped them', () => {
    expect(shouldSeedAfterEdit({ beforeStatus: 'active', afterStatus: 'active', isTest: false, changedKeys: ['street', 'city'] })).toBe(true)
    expect(shouldSeedAfterEdit({ beforeStatus: 'active', afterStatus: 'active', isTest: false, changedKeys: ['bank_name'] })).toBe(true)
  })

  it('does not ask for an unrelated edit to an active student', () => {
    expect(shouldSeedAfterEdit({ beforeStatus: 'active', afterStatus: 'active', isTest: false, changedKeys: ['phone', 'school_id'] })).toBe(false)
  })

  it('never asks for a student who is not active, or for a test account', () => {
    expect(shouldSeedAfterEdit({ beforeStatus: 'pending', afterStatus: 'pending', isTest: false, changedKeys: ['street'] })).toBe(false)
    expect(shouldSeedAfterEdit({ beforeStatus: 'active', afterStatus: 'archived', isTest: false, changedKeys: ['status'] })).toBe(false)
    expect(shouldSeedAfterEdit({ beforeStatus: 'pending', afterStatus: 'active', isTest: true, changedKeys: ['status'] })).toBe(false)
  })
})

/** Just enough of the query builder: from(t).select().eq().eq() resolves to canned rows. */
function fakeDb(tables: Record<string, { data: unknown[] | null; error?: { message: string } | null }>) {
  return {
    from(table: string) {
      const result = tables[table] ?? { data: [] }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: result.data, error: result.error ?? null }).then(res)
      }
      return chain
    }
  }
}

const args = { bamId: 'bam-1', cohortId: 'coh-1', period: '2026-09-01', monthLabel: 'September 2026' }
const cohortRow = { data: [{ start_date: '2026-09-01', end_date: '2027-04-30' }] }

describe('seedIfMissing', () => {
  it('creates the invoice when none exists and says so', async () => {
    const seed = vi.fn().mockResolvedValue({ ok: true, created: true, paidCad: 150, invoiceNumber: 'INV-LMA1' })
    const out = await seedIfMissing(fakeDb({ cohorts: cohortRow, invoices: { data: [] } }) as never, args, seed as never)
    expect(seed).toHaveBeenCalledWith(expect.anything(), { bamId: 'bam-1', cohortId: 'coh-1', period: '2026-09-01' })
    expect(out).toMatchObject({ ok: true, created: true })
    expect(out.note).toContain('INV-LMA1')
  })

  it('leaves an existing invoice alone, whatever its status, so an admin edit is never rewritten', async () => {
    const seed = vi.fn()
    const db = fakeDb({ cohorts: cohortRow, invoices: { data: [{ id: 'i1', invoice_number: 'INV-LMA1', status: 'sent' }] } })
    const out = await seedIfMissing(db as never, args, seed as never)
    expect(seed).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: true, created: false, quiet: true })
    expect(out.note).toContain('already exists')
  })

  it('reports why nothing was made, so a blank address is not a silent success', async () => {
    const seed = vi.fn().mockResolvedValue({ ok: false, reason: 'HARD BLOCK: mailing address incomplete (missing street, city, prov, postal)' })
    const out = await seedIfMissing(fakeDb({ cohorts: cohortRow, invoices: { data: [] } }) as never, args, seed as never)
    expect(out).toMatchObject({ ok: false, created: false, quiet: false })
    expect(out.note).toContain('mailing address incomplete')
  })

  it('does nothing for a month the program does not run', async () => {
    const seed = vi.fn()
    const out = await seedIfMissing(
      fakeDb({ cohorts: cohortRow, invoices: { data: [] } }) as never,
      { ...args, period: '2026-08-01', monthLabel: 'August 2026' }, seed as never)
    expect(seed).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: true, created: false, quiet: true })
  })

  it('refuses rather than guess when it cannot read the invoices', async () => {
    const seed = vi.fn()
    const db = fakeDb({ cohorts: cohortRow, invoices: { data: null, error: { message: 'timeout' } } })
    const out = await seedIfMissing(db as never, args, seed as never)
    expect(seed).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: false })
    expect(out.note).toContain('timeout')
  })

  it('refuses when the cohort cannot be read', async () => {
    const seed = vi.fn()
    const out = await seedIfMissing(fakeDb({ cohorts: { data: null, error: { message: 'down' } } }) as never, args, seed as never)
    expect(seed).not.toHaveBeenCalled()
    expect(out.ok).toBe(false)
  })
})
