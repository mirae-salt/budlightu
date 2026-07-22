-- BLU Invoice · system-field locks + audit-log auto-write
-- Prevent non-super-admin from editing generated fields.

create or replace function require_super_admin() returns trigger
language plpgsql as $$
begin
  if current_role_claim() <> 'super_admin' and
     coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role' then
    raise exception 'system field is read-only for role %', current_role_claim();
  end if;
  return new;
end $$;

-- ============================================================================
-- invoices: invoice_number, seq, pdf_key, payload_json — locked from admin UI
-- ============================================================================
create or replace function invoices_system_fields_guard() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'UPDATE' then
    if (new.invoice_number is distinct from old.invoice_number
        or new.seq is distinct from old.seq
        or new.pdf_key is distinct from old.pdf_key
        or new.payload_json is distinct from old.payload_json)
       and current_role_claim() <> 'super_admin'
       and coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role' then
      raise exception 'invoice system fields are read-only';
    end if;
  end if;
  return new;
end $$;

create trigger invoices_lock_system_fields
  before update on invoices
  for each row execute function invoices_system_fields_guard();

-- ============================================================================
-- ledger: paid_usd, spendable_cap_usd, cap_snapshot_usd — system only
-- ============================================================================
create or replace function ledger_system_fields_guard() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'UPDATE' then
    if (new.paid_usd is distinct from old.paid_usd
        or new.spendable_cap_usd is distinct from old.spendable_cap_usd
        or new.cap_snapshot_usd is distinct from old.cap_snapshot_usd
        or new.policy_version is distinct from old.policy_version)
       and current_role_claim() <> 'super_admin'
       and coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role' then
      raise exception 'ledger system fields are read-only';
    end if;
  end if;
  return new;
end $$;

create trigger ledger_lock_system_fields
  before update on reimbursement_ledger
  for each row execute function ledger_system_fields_guard();

-- ============================================================================
-- bams: initials_resolved, email_verified_at, auth_user_id — system only
-- ============================================================================
create or replace function bams_system_fields_guard() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'UPDATE' then
    if (new.initials_resolved is distinct from old.initials_resolved
        or new.email_verified_at is distinct from old.email_verified_at
        or new.auth_user_id is distinct from old.auth_user_id
        or new.invite_token_hash is distinct from old.invite_token_hash)
       and current_role_claim() <> 'super_admin'
       and coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role' then
      raise exception 'bams system fields are read-only';
    end if;
  end if;
  return new;
end $$;

create trigger bams_lock_system_fields
  before update on bams
  for each row execute function bams_system_fields_guard();

-- ============================================================================
-- Audit log auto-write on money-adjacent tables
-- ============================================================================
create or replace function write_audit_log() returns trigger
language plpgsql as $$
declare
  v_actor uuid;
  v_role text;
  v_entity_id uuid;
begin
  v_actor := auth.uid();
  v_role  := current_role_claim();

  -- policy's primary key is `key` (text), not `id` (uuid); audit_log.entity_id
  -- stays null for those rows rather than referencing a column that doesn't exist.
  if TG_TABLE_NAME = 'policy' then
    v_entity_id := null;
  else
    v_entity_id := coalesce(new.id, old.id);
  end if;

  insert into audit_log (actor_id, actor_role, entity, entity_id, action, before_json, after_json)
  values (
    v_actor,
    v_role,
    TG_TABLE_NAME,
    v_entity_id,
    lower(TG_OP),
    case when TG_OP <> 'INSERT' then row_to_json(old)::jsonb else null end,
    case when TG_OP <> 'DELETE' then row_to_json(new)::jsonb else null end
  );

  return coalesce(new, old);
end $$;

create trigger audit_invoices          after insert or update or delete on invoices
  for each row execute function write_audit_log();
create trigger audit_ledger            after insert or update or delete on reimbursement_ledger
  for each row execute function write_audit_log();
create trigger audit_invoice_sends     after insert or update or delete on invoice_sends
  for each row execute function write_audit_log();
create trigger audit_ap_cancellations  after insert or update or delete on ap_cancellations
  for each row execute function write_audit_log();
create trigger audit_bams              after update on bams
  for each row execute function write_audit_log();
create trigger audit_policy            after insert or update or delete on policy
  for each row execute function write_audit_log();

-- ============================================================================
-- Advisory-lock helper for scheduled jobs (P0-5a)
-- ============================================================================
create or replace function try_scheduler_lock(job_name text) returns boolean
language sql as $$
  select pg_try_advisory_xact_lock(hashtext(job_name))
$$;

comment on function try_scheduler_lock is
  'Returns true if this transaction acquired the advisory lock for `job_name`. '
  'Use at the start of scheduled edge functions to prevent double-fire.';
