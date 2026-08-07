/**
 * Banking correction request flow.
 *
 * These cover the four properties the feature exists for:
 *   1. a bad account number never becomes a request
 *   2. a second request cannot open while one is pending
 *   3. a type-to-confirm mismatch blocks the approval
 *   4. applying a change clears bams.email_verified_at
 *
 * Plus the shape of migration 0022, in the style of rls-shape.test.ts: the SQL
 * is the thing that actually enforces encryption, RLS and the one-pending limit,
 * so it is asserted rather than assumed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  validateBankingRequestInput,
  checkRequestLimit,
  accountConfirmMatches,
  buildAppliedBamPatch,
  tail4,
  MAX_REQUESTS_PER_WINDOW,
  MIN_REASON_LENGTH
} from '../lib/banking-request'

const MIG = readFileSync(
  join(__dirname, '..', 'supabase', 'migrations', '0022_banking_change_requests.sql'),
  'utf8'
)

const GOOD = {
  bank_name: 'RBC Royal Bank',
  institution_no: '003',
  transit_no: '05162',
  account_no: '0001234567',
  reason: 'I mistyped my account number during onboarding.'
}

describe('validation · a bad account number never becomes a request', () => {
  it('rejects a too-short account number', () => {
    const res = validateBankingRequestInput({ ...GOOD, account_no: '12345' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/account/i)
  })

  it('rejects an account number with non-digits', () => {
    expect(validateBankingRequestInput({ ...GOOD, account_no: '12345678a' }).ok).toBe(false)
    expect(validateBankingRequestInput({ ...GOOD, account_no: '1234-5678' }).ok).toBe(false)
  })

  it('rejects a numeric (non-string) account number, which is how leading zeros die', () => {
    const res = validateBankingRequestInput({ ...GOOD, account_no: 1234567 })
    expect(res.ok).toBe(false)
  })

  it('rejects a too-long account number', () => {
    expect(validateBankingRequestInput({ ...GOOD, account_no: '1234567890123' }).ok).toBe(false)
  })

  it('rejects bad institution and transit shapes', () => {
    expect(validateBankingRequestInput({ ...GOOD, institution_no: '3' }).ok).toBe(false)
    expect(validateBankingRequestInput({ ...GOOD, transit_no: '722' }).ok).toBe(false)
  })

  it('rejects an unknown bank instead of guessing a routing number', () => {
    const res = validateBankingRequestInput({ ...GOOD, bank_name: 'Bank of Nowhere' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/not in our lookup/i)
  })

  it('requires a reason', () => {
    expect(validateBankingRequestInput({ ...GOOD, reason: 'oops' }).ok).toBe(false)
    expect(validateBankingRequestInput({ ...GOOD, reason: 'x'.repeat(MIN_REASON_LENGTH) }).ok).toBe(true)
    expect(validateBankingRequestInput({ ...GOOD, reason: 'x'.repeat(5000) }).ok).toBe(false)
  })

  it('accepts a valid request and keeps every digit a string, leading zeros intact', () => {
    const res = validateBankingRequestInput(GOOD)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.accountNo).toBe('0001234567')
    expect(res.value.transitNo).toBe('05162')
    expect(res.value.institutionNo).toBe('003')
    expect(typeof res.value.accountNo).toBe('string')
    // the display name comes from the lookup table, not from what was typed
    expect(res.value.bankName).toBe('RBC Royal Bank')
    expect(res.value.institutionMismatch).toBe(false)
  })

  // The BOM is written as an escape, never as a literal: a literal one is
  // invisible in review, which is the failure this test exists to cover.
  it('strips invisible characters without eating digits (BOM class)', () => {
    const res = validateBankingRequestInput({ ...GOOD, account_no: '\uFEFF0001234567 ' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.accountNo).toBe('0001234567')
  })

  it('flags an institution number that disagrees with the chosen bank, without blocking', () => {
    const res = validateBankingRequestInput({ ...GOOD, institution_no: '004' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.institutionMismatch).toBe(true)
    expect(res.value.expectedInstitutionNo).toBe('003')
  })
})

describe('rate limit · a second pending request is refused', () => {
  const now = new Date('2026-08-07T12:00:00Z')
  const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86400000).toISOString()

  it('refuses while one is still pending', () => {
    const res = checkRequestLimit([{ status: 'pending', requested_at: iso(1) }], now)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/already have a banking change/i)
  })

  it('allows a new one once the previous was decided', () => {
    expect(checkRequestLimit([{ status: 'applied', requested_at: iso(10) }], now).ok).toBe(true)
    expect(checkRequestLimit([{ status: 'rejected', requested_at: iso(10) }], now).ok).toBe(true)
    expect(checkRequestLimit([], now).ok).toBe(true)
  })

  it('refuses churn: too many requests in the trailing window', () => {
    const rows = Array.from({ length: MAX_REQUESTS_PER_WINDOW }, () => ({
      status: 'rejected', requested_at: iso(2)
    }))
    expect(checkRequestLimit(rows, now).ok).toBe(false)
  })

  it('does not count requests outside the window', () => {
    const rows = Array.from({ length: MAX_REQUESTS_PER_WINDOW }, () => ({
      status: 'rejected', requested_at: iso(400)
    }))
    expect(checkRequestLimit(rows, now).ok).toBe(true)
  })

  it('counts an unparseable date toward the limit (fail closed)', () => {
    const rows = Array.from({ length: MAX_REQUESTS_PER_WINDOW }, () => ({
      status: 'rejected', requested_at: 'not a date'
    }))
    expect(checkRequestLimit(rows, now).ok).toBe(false)
  })
})

describe('type-to-confirm · a mismatch blocks approval', () => {
  it('blocks when the typed number differs', () => {
    expect(accountConfirmMatches('0001234568', '0001234567')).toBe(false)
  })

  it('blocks when only the leading zeros differ', () => {
    expect(accountConfirmMatches('1234567', '0001234567')).toBe(false)
    expect(accountConfirmMatches('0001234567', '1234567')).toBe(false)
  })

  it('blocks an empty or missing confirmation, so a blank box is never a pass', () => {
    expect(accountConfirmMatches('', '0001234567')).toBe(false)
    expect(accountConfirmMatches(undefined, '0001234567')).toBe(false)
    expect(accountConfirmMatches('0001234567', null)).toBe(false)
    expect(accountConfirmMatches('', '')).toBe(false)
  })

  it('allows an exact match, tolerating pasted whitespace and invisibles only', () => {
    expect(accountConfirmMatches('0001234567', '0001234567')).toBe(true)
    expect(accountConfirmMatches(' 000 1234 567 ', '0001234567')).toBe(true)
    expect(accountConfirmMatches('\uFEFF0001234567', '0001234567')).toBe(true)
  })
})

describe('applying · the student must re-verify', () => {
  it('nulls email_verified_at so /portal/verify-account runs again', () => {
    const patch = buildAppliedBamPatch('TD Canada Trust')
    expect(patch.email_verified_at).toBeNull()
    expect(patch.bank_name).toBe('TD Canada Trust')
  })

  it('never carries banking values in the bams patch (those go through the encrypt RPC)', () => {
    const patch = buildAppliedBamPatch('TD Canada Trust') as Record<string, unknown>
    expect(Object.keys(patch).sort()).toEqual(['bank_name', 'email_verified_at'])
  })

  it('tail4 shows only the last 4 for audit and display', () => {
    expect(tail4('0001234567')).toBe('4567')
    expect(tail4('123')).toBeNull()
    expect(tail4(null)).toBeNull()
  })
})

describe('migration 0022 · shape', () => {
  it('stores the requested values encrypted with the 0003 pattern', () => {
    expect(MIG).toMatch(/pgp_sym_encrypt\(p_account_no,\s*v_key\)/)
    expect(MIG).toMatch(/encode\(pgp_sym_encrypt/)
    expect(MIG).toMatch(/name = 'blu_banking_key'/)
    expect(MIG).toMatch(/create or replace function encrypt_banking_request[\s\S]*?security definer/i)
    expect(MIG).toMatch(/create or replace function decrypt_banking_request[\s\S]*?security definer/i)
  })

  it('structurally rejects a plaintext banking value in the request table', () => {
    expect(MIG).toMatch(/bcr_ciphertext_only check/i)
    expect(MIG).toMatch(/account_no\s+!~ '\^\[0-9\]\+\$'/)
  })

  it('refuses to decrypt for a non-admin caller', () => {
    expect(MIG).toMatch(/raise exception 'not authorized to decrypt banking'/i)
    expect(MIG).toMatch(/raise exception 'not authorized to submit a banking change request'/i)
  })

  it('revokes the default PUBLIC execute grant on both functions', () => {
    expect(MIG).toMatch(/revoke all on function encrypt_banking_request\([^)]*\) from public/i)
    expect(MIG).toMatch(/revoke all on function decrypt_banking_request\(uuid\) from public/i)
  })

  it('limits a BAM to one pending request via a partial unique index', () => {
    expect(MIG).toMatch(/create unique index[\s\S]*?banking_change_requests_one_pending[\s\S]*?where status = 'pending'/i)
  })

  it('has RLS with self-read and self-insert, and no student update or delete policy', () => {
    expect(MIG).toMatch(/alter table banking_change_requests enable row level security/i)
    expect(MIG).toMatch(/policy banking_requests_self_read on banking_change_requests for select[\s\S]*?bam_id = current_bam_id\(\)/i)
    expect(MIG).toMatch(/policy banking_requests_self_insert on banking_change_requests for insert/i)
    expect(MIG).toMatch(/policy banking_requests_admin_all on banking_change_requests/i)
    expect(MIG).not.toMatch(/policy banking_requests_self_(update|delete)/i)
  })

  it('constrains status to the four states', () => {
    expect(MIG).toMatch(/check \(status in \('pending','approved','rejected','applied'\)\)/)
  })
})
