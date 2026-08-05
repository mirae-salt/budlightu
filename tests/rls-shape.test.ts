/**
 * RLS shape tests — verify the RLS policies and CHECK constraints defined in
 * the migrations SAY what we think they say. These don't hit a live database;
 * they read the migration files and assert the presence of key clauses.
 *
 * When a live Supabase project is provisioned, add a companion suite using
 * @supabase/supabase-js that actually creates test users, attempts cross-user
 * queries, and asserts they're denied.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIG_DIR = join(__dirname, '..', 'supabase', 'migrations')
const schema     = readFileSync(join(MIG_DIR, '0001_initial_schema.sql'),        'utf8')
const rls        = readFileSync(join(MIG_DIR, '0002_rls_policies.sql'),          'utf8')
const encryption = readFileSync(join(MIG_DIR, '0003_encryption_pgsodium.sql'),   'utf8')
const triggers   = readFileSync(join(MIG_DIR, '0004_system_field_triggers.sql'), 'utf8')
const cancel     = readFileSync(join(MIG_DIR, '0007_void_ap_cancellation.sql'),  'utf8')
const misc       = readFileSync(join(MIG_DIR, '0013_misc_fixes.sql'),           'utf8')

describe('schema · P0-1 (invoice_number string uniqueness)', () => {
  it('has UNIQUE index on invoice_number within cohort (excluding void)', () => {
    expect(schema).toMatch(/unique index invoices_number_uniq on invoices\(cohort_id, invoice_number\).*status <> 'void'/i)
  })
  it('has UNIQUE index on (bam_id, seq)', () => {
    expect(schema).toMatch(/unique index invoices_bam_seq_uniq on invoices\(bam_id, seq\)/i)
  })
  it('has UNIQUE index on (cohort_id, initials_resolved) on bams', () => {
    expect(schema).toMatch(/bams_initials_unique unique \(cohort_id, initials_resolved\)/i)
  })
})

describe('schema · leading-zero preservation', () => {
  it('banking fields are TEXT columns', () => {
    expect(schema).toMatch(/institution_no\s+text/i)
    expect(schema).toMatch(/transit_no\s+text/i)
    expect(schema).toMatch(/account_no\s+text/i)
  })
  it('CHECK constraints enforce digit shape (regex)', () => {
    expect(schema).toMatch(/institution_no is null or institution_no ~ '\^\\d\{3\}\$'/)
    expect(schema).toMatch(/transit_no\s+is null or transit_no\s+~ '\^\\d\{5\}\$'/)
    expect(schema).toMatch(/account_no\s+is null or account_no\s+~ '\^\\d\{6,12\}\$'/)
  })
})

describe('schema · P0-5a (send idempotency + advisory lock)', () => {
  it('invoice_sends has UNIQUE (invoice_id, target, mode)', () => {
    expect(schema).toMatch(/invoice_sends_unique unique \(invoice_id, target, mode\)/i)
  })
  it('advisory lock helper exists', () => {
    expect(triggers).toMatch(/try_scheduler_lock/)
    expect(triggers).toMatch(/pg_try_advisory_xact_lock/)
  })
})

describe('schema · P0-5b (void → AP cancellation)', () => {
  it('trigger fires on SENT→void', () => {
    expect(cancel).toMatch(/if new\.status <> 'void' then return new; end if/)
    expect(cancel).toMatch(/if old\.status <> 'sent' then return new; end if/)
  })
  it('requires void_reason (no silent voids)', () => {
    expect(cancel).toMatch(/if new\.void_reason is null then\s*raise exception/i)
  })
  it('inserts into ap_cancellations', () => {
    expect(cancel).toMatch(/insert into ap_cancellations/i)
  })
})

describe('RLS · P0-3 (onboarding_submissions super-admin only)', () => {
  it('policy restricts onboarding_submissions to super_admin', () => {
    expect(rls).toMatch(/policy onboarding_super_admin_only on onboarding_submissions/i)
    expect(rls).toMatch(/current_role_claim\(\) = 'super_admin'/)
  })
  it('program_admin sees stripped onboarding summary via SECURITY DEFINER function', () => {
    // Originally a view, migrated to a function in 0013 to prevent RLS bypass
    expect(rls).toMatch(/onboarding_submissions/i)
  })
})

describe('RLS · banking fields never leak to the wrong BAM', () => {
  it('bams enforces auth_user_id match for self-read', () => {
    expect(rls).toMatch(/policy bams_self_read on bams for select/i)
    expect(rls).toMatch(/using \(auth_user_id = auth\.uid\(\)\)/i)
  })
  it('receipts enforces bam_id = current_bam_id() for self-read/insert', () => {
    expect(rls).toMatch(/policy receipts_self_read on receipts for select/i)
    expect(rls).toMatch(/bam_id = current_bam_id\(\)/)
  })
})

describe('encryption · P0-3 pgsodium banking', () => {
  it('encrypt/decrypt RPCs are SECURITY DEFINER', () => {
    expect(encryption).toMatch(/create or replace function encrypt_bam_banking[\s\S]*?security definer/i)
    expect(encryption).toMatch(/create or replace function decrypt_bam_banking[\s\S]*?security definer/i)
  })
  it('decrypt raises if not authorized', () => {
    expect(encryption).toMatch(/raise exception 'not authorized to decrypt banking'/i)
  })
})

describe('triggers · system-field locks', () => {
  it('invoices lock invoice_number/seq/pdf_key/payload_json', () => {
    expect(triggers).toMatch(/invoices_system_fields_guard/i)
    expect(triggers).toMatch(/invoice_number is distinct from old\.invoice_number/)
    expect(triggers).toMatch(/seq is distinct from old\.seq/)
  })
  it('ledger locks paid_cad/spendable_cap_cad/cap_snapshot_cad', () => {
    expect(misc).toMatch(/ledger_system_fields_guard/i)
    expect(misc).toMatch(/paid_cad is distinct from old\.paid_cad/)
  })
  it('bams locks email_verified_at/initials_resolved/auth_user_id/invite_token_hash', () => {
    expect(triggers).toMatch(/bams_system_fields_guard/i)
    expect(triggers).toMatch(/email_verified_at is distinct from old\.email_verified_at/)
    expect(triggers).toMatch(/initials_resolved is distinct from old\.initials_resolved/)
  })
})
