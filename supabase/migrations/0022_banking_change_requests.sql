-- BLU Invoice · banking correction REQUESTS (BAM asks, Robin applies)
--
-- Why this table exists: a BAM types their own banking once, during onboarding.
-- A typo in the account number had no product path to a fix (email Robin, nothing
-- recorded). Letting the BAM edit `bams.institution_no/transit_no/account_no`
-- directly is not an option: anyone who gets into a student's session could
-- redirect that student's pay. So the BAM submits a REQUEST and an admin applies it.
--
-- Security properties this migration is responsible for:
--   1. A request can never apply itself. Nothing here writes to `bams`. The only
--      writer is /api/admin/banking-requests/decide, after an admin re-typed the
--      account number (type-to-confirm) and requireAdmin() passed.
--   2. The requested values are PII and are stored ENCRYPTED, same pattern as
--      `encrypt_bam_banking` in 0003: pgp_sym_encrypt keyed by the
--      `blu_banking_key` vault secret, stored base64, read back only through a
--      security-definer function. This is the exact defect P0-3 fixed for the
--      onboarding parking table; it is not reintroduced here.
--   3. One pending request per BAM (partial unique index), so the review queue
--      cannot be spammed from a compromised student session.
--
-- Leading zeros: the three banking columns are TEXT and only ever hold ciphertext.
-- The plaintext behind them is validated as a STRING (lib/validation.ts) before it
-- ever reaches this table. Nothing numeric touches these values anywhere.

-- ============================================================================
-- Table
-- ============================================================================
create table if not exists banking_change_requests (
  id              uuid primary key default gen_random_uuid(),
  bam_id          uuid not null references bams(id),

  status          text not null default 'pending'
                  check (status in ('pending','approved','rejected','applied')),

  -- The BAM's own words: why they are asking. Free text, never used as a value.
  reason          text not null,

  -- Bank display name resolved through lib/banks.ts `lookupBank` before insert.
  -- An unknown bank hard-fails in the route; it never reaches this column.
  bank_name       text not null,

  -- Encrypted at rest (base64 of pgp_sym_encrypt output). See the CHECKs below:
  -- a plaintext digit string is structurally rejected, so no code path -- not even
  -- a direct PostgREST insert under the BAM's own RLS policy -- can park a
  -- readable account number here.
  institution_no  text not null,
  transit_no      text not null,
  account_no      text not null,

  requested_at    timestamptz not null default now(),

  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text,

  constraint bcr_ciphertext_only check (
    institution_no !~ '^[0-9]+$' and length(institution_no) > 40 and
    transit_no     !~ '^[0-9]+$' and length(transit_no)     > 40 and
    account_no     !~ '^[0-9]+$' and length(account_no)     > 40
  ),
  constraint bcr_reason_not_empty check (length(btrim(reason)) >= 10),
  constraint bcr_decision_recorded check (
    (status in ('pending')            and decided_by is null and decided_at is null)
    or
    (status in ('approved','rejected','applied') and decided_at is not null)
  )
);

-- Rate limit, structural: a BAM may have at most ONE open request. A second
-- submission is refused by the database, not only by the route.
create unique index if not exists banking_change_requests_one_pending
  on banking_change_requests(bam_id) where status = 'pending';

create index if not exists banking_change_requests_queue_idx
  on banking_change_requests(status, requested_at desc);

comment on table banking_change_requests is
  'BAM-submitted banking correction requests. Values are encrypted; only an admin '
  'action (type-to-confirm) copies them into bams via encrypt_bam_banking.';

-- ============================================================================
-- Encrypted write (mirrors encrypt_bam_banking in 0003)
-- ============================================================================
create or replace function encrypt_banking_request(
  p_bam_id uuid,
  p_reason text,
  p_bank_name text,
  p_institution_no text,
  p_transit_no text,
  p_account_no text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text;
  v_id  uuid;
begin
  -- 0003's encrypt_bam_banking has no caller check; this one does. A SECURITY
  -- DEFINER function that writes PII must not be callable by an ordinary session
  -- with an arbitrary p_bam_id.
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and current_role_claim() not in ('super_admin','program_admin') then
    raise exception 'not authorized to submit a banking change request';
  end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'blu_banking_key'
  limit 1;

  if v_key is null then
    raise exception 'blu_banking_key not found in vault; provision via dashboard';
  end if;

  insert into banking_change_requests
    (bam_id, reason, bank_name, institution_no, transit_no, account_no)
  values (
    p_bam_id,
    p_reason,
    p_bank_name,
    encode(pgp_sym_encrypt(p_institution_no, v_key), 'base64'),
    encode(pgp_sym_encrypt(p_transit_no,     v_key), 'base64'),
    encode(pgp_sym_encrypt(p_account_no,     v_key), 'base64')
  )
  returning id into v_id;

  return v_id;
end $$;

-- ============================================================================
-- Encrypted read (mirrors decrypt_bam_banking in 0003)
-- ============================================================================
create or replace function decrypt_banking_request(p_request_id uuid)
returns table (
  institution_no text,
  transit_no text,
  account_no text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text;
  v_req banking_change_requests%rowtype;
begin
  if current_role_claim() not in ('super_admin','program_admin') and
     current_setting('request.jwt.claims', true)::jsonb->>'role' <> 'service_role' then
    raise exception 'not authorized to decrypt banking';
  end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'blu_banking_key'
  limit 1;

  if v_key is null then
    raise exception 'blu_banking_key not found in vault; provision via dashboard';
  end if;

  select * into v_req from banking_change_requests where id = p_request_id;

  return query
  select
    pgp_sym_decrypt(decode(v_req.institution_no, 'base64'), v_key),
    pgp_sym_decrypt(decode(v_req.transit_no,     'base64'), v_key),
    pgp_sym_decrypt(decode(v_req.account_no,     'base64'), v_key);
end $$;

comment on function encrypt_banking_request is
  'Encrypt-and-insert a BAM banking correction request. Service role only.';
comment on function decrypt_banking_request is
  'Decrypt one banking correction request. super_admin, program_admin or service_role only.';

-- Execute privilege, not just the in-body check. Postgres grants EXECUTE to
-- PUBLIC by default, which would let any signed-in student call these directly.
revoke all on function encrypt_banking_request(uuid, text, text, text, text, text) from public;
revoke all on function decrypt_banking_request(uuid) from public;
grant execute on function encrypt_banking_request(uuid, text, text, text, text, text) to service_role;
grant execute on function decrypt_banking_request(uuid) to service_role;

-- ============================================================================
-- RLS — a BAM reads and inserts only their own; admins read all
-- (style follows 0002_rls_policies.sql)
-- ============================================================================
alter table banking_change_requests enable row level security;

create policy banking_requests_admin_all on banking_change_requests
  for all using (current_role_claim() in ('program_admin','super_admin'))
  with check (current_role_claim() in ('program_admin','super_admin'));

create policy banking_requests_self_read on banking_change_requests for select
  using (bam_id = current_bam_id());

-- Insert is allowed only for the caller's own BAM row, only in 'pending', and
-- only with no decision fields pre-filled. The real insert path is the
-- SECURITY DEFINER function above (which also encrypts); this policy is the
-- fence that makes a hand-rolled insert for SOMEONE ELSE impossible.
create policy banking_requests_self_insert on banking_change_requests for insert
  with check (
    bam_id = current_bam_id()
    and status = 'pending'
    and decided_by is null
    and decided_at is null
  );

-- No update/delete policy for students: a BAM cannot approve, retract-and-resubmit
-- around the pending limit, or rewrite a request after Robin has looked at it.

-- ============================================================================
-- Notes for adjacent code
-- ============================================================================
-- admin_notifications.type gains 'banking_change_request' (that column is free
-- text, no CHECK, so no schema change is needed here). See lib/notify-admin.ts
-- and app/admin/_components/TopBar.tsx TYPE_ICONS.
--
-- Applying a request sets bams.email_verified_at = null. That column is guarded
-- by bams_system_fields_guard (0004), which permits service_role, and the admin
-- decide route uses the service client.
