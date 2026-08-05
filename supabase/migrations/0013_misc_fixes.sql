-- 1. audit_log trigger: add SECURITY DEFINER so it can insert into audit_log
--    even when triggered by BAM-initiated writes (BAM has no insert policy on audit_log).
create or replace function write_audit_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid;
  v_role text;
  v_entity_id uuid;
begin
  v_actor := auth.uid();
  v_role  := current_role_claim();

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

-- 2. Add index on bams.invite_token_hash for onboarding token lookup
create index if not exists idx_bams_invite_token_hash on bams(invite_token_hash)
  where invite_token_hash is not null;

-- 3. Column rename: _usd → _cad (currency is CAD, not USD)
alter table reimbursement_ledger rename column entitlement_usd to entitlement_cad;
alter table reimbursement_ledger rename column spent_usd to spent_cad;
alter table reimbursement_ledger rename column carryover_in_usd to carryover_in_cad;
alter table reimbursement_ledger rename column carryover_out_usd to carryover_out_cad;
alter table reimbursement_ledger rename column paid_usd to paid_cad;
alter table reimbursement_ledger rename column spendable_cap_usd to spendable_cap_cad;
alter table reimbursement_ledger rename column cap_snapshot_usd to cap_snapshot_cad;

-- Also update the system-field guard trigger to reference new column names
create or replace function ledger_system_fields_guard() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'UPDATE' then
    if (new.paid_cad is distinct from old.paid_cad
        or new.spendable_cap_cad is distinct from old.spendable_cap_cad
        or new.cap_snapshot_cad is distinct from old.cap_snapshot_cad
        or new.policy_version is distinct from old.policy_version)
       and current_role_claim() <> 'super_admin'
       and coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role' then
      raise exception 'ledger system fields are read-only';
    end if;
  end if;
  return new;
end $$;

-- 4. onboarding_submissions_summary: recreate as SECURITY DEFINER function
--    to prevent RLS bypass through the view
drop view if exists onboarding_submissions_summary;

create or replace function get_onboarding_summary()
returns table (
  id uuid,
  submitted_email text,
  matched_bam_id uuid,
  status text,
  flag_reason text,
  submitted_at timestamptz,
  resolved_at timestamptz,
  purge_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select id, submitted_email, matched_bam_id, status, flag_reason,
         submitted_at, resolved_at, purge_at
  from onboarding_submissions
$$;

-- Only admins can call it
revoke all on function get_onboarding_summary() from public;
grant execute on function get_onboarding_summary() to authenticated;
