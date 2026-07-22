-- BLU Invoice · at-rest encryption for banking PII
-- P0-3 fix: banking fields encrypted via pgcrypto's pgp_sym_encrypt, keyed by a
-- passphrase stored in Supabase Vault. Only Edge Functions with service role
-- (or super_admin/program_admin, for the decrypt RPC) can decrypt.
--
-- NOTE: newer Supabase projects (Postgres 17 / vault 0.3+) don't expose the
-- `pgsodium` schema for direct use — it's internal to Vault's own secret
-- storage now. pgcrypto (already bundled) covers the same need: pgp_sym_encrypt
-- takes a plain-text passphrase, so the vault secret can be used as-is with no
-- byte-length requirements. Non-deterministic ciphertext (random IV per call)
-- is fine here since nothing does equality lookups on encrypted banking fields.

-- ============================================================================
-- Store encryption key in Vault (skeleton — actual key added via Supabase dashboard)
-- ============================================================================
-- Vault entries are created out-of-band via:
--   SELECT vault.create_secret('<random passphrase>', 'blu_banking_key');
-- Then referenced here by name.

-- ============================================================================
-- Encrypted-write helpers (SECURITY DEFINER; only Edge Functions call these)
-- ============================================================================

create or replace function encrypt_bam_banking(
  p_bam_id uuid,
  p_institution_no text,
  p_transit_no text,
  p_account_no text,
  p_hst_number text default null
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text;
begin
  -- fetch key from vault
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'blu_banking_key'
  limit 1;

  if v_key is null then
    raise exception 'blu_banking_key not found in vault; provision via dashboard';
  end if;

  update bams set
    institution_no = case
      when p_institution_no is not null
      then encode(pgp_sym_encrypt(p_institution_no, v_key), 'base64')
      else institution_no end,
    transit_no = case
      when p_transit_no is not null
      then encode(pgp_sym_encrypt(p_transit_no, v_key), 'base64')
      else transit_no end,
    account_no = case
      when p_account_no is not null
      then encode(pgp_sym_encrypt(p_account_no, v_key), 'base64')
      else account_no end,
    hst_number = case
      when p_hst_number is not null
      then encode(pgp_sym_encrypt(p_hst_number, v_key), 'base64')
      else hst_number end
  where id = p_bam_id;
end $$;

create or replace function decrypt_bam_banking(p_bam_id uuid)
returns table (
  institution_no text,
  transit_no text,
  account_no text,
  hst_number text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text;
  v_bam bams%rowtype;
begin
  -- restrict to service_role callers
  if current_role_claim() not in ('super_admin','program_admin') and
     current_setting('request.jwt.claims', true)::jsonb->>'role' <> 'service_role' then
    raise exception 'not authorized to decrypt banking';
  end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'blu_banking_key'
  limit 1;

  select * into v_bam from bams where id = p_bam_id;

  return query
  select
    case when v_bam.institution_no is null then null
         else pgp_sym_decrypt(decode(v_bam.institution_no, 'base64'), v_key) end,
    case when v_bam.transit_no is null then null
         else pgp_sym_decrypt(decode(v_bam.transit_no, 'base64'), v_key) end,
    case when v_bam.account_no is null then null
         else pgp_sym_decrypt(decode(v_bam.account_no, 'base64'), v_key) end,
    case when v_bam.hst_number is null then null
         else pgp_sym_decrypt(decode(v_bam.hst_number, 'base64'), v_key) end;
end $$;

comment on function encrypt_bam_banking is
  'Encrypt-and-store banking fields for a BAM. Called only from Edge Functions with service role.';
comment on function decrypt_bam_banking is
  'Decrypt banking fields for a BAM. Only super_admin, program_admin, or service_role permitted.';

-- NOTE: existing CHECK constraints (bams_institution_shape etc.) validate DECRYPTED
-- values, not ciphertext. In practice we validate before encrypting inside the
-- edge function; the DB constraints are dropped in a later migration once we're
-- confident encryption is stable (see 0004).
