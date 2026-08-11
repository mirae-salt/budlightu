-- 0024 — close two SECURITY DEFINER functions that the browser key can execute.
--
-- FOUND BY: scripts/probe/rpc-grants.js, which calls each function with the ANON key
-- (the one in the browser bundle) against a uuid that cannot exist, so nothing is
-- read or written and only the grant is observed. Output before this migration:
--
--   FAIL  encrypt_bam_banking     EXECUTABLE by the anon key. Returned no error.
--   PASS  decrypt_bam_banking     ran, then refused: "not authorized to decrypt banking"
--   FAIL  get_onboarding_summary  EXECUTABLE by the anon key. Returned no error.
--
-- and a follow-up read confirmed get_onboarding_summary returns rows to a caller with
-- NO SESSION AT ALL: id, submitted_email, matched_bam_id, status, flag_reason,
-- submitted_at, resolved_at, purge_at.
--
-- WHY THIS HAPPENED
-- CREATE FUNCTION grants EXECUTE TO PUBLIC by default. SECURITY DEFINER then makes
-- the function run as its owner, so RLS on the underlying table is not consulted.
-- 0003 created encrypt_bam_banking with a comment saying "only Edge Functions call
-- these" and never revoked anything, so "who calls it" was a convention, not a rule.
-- 0013 created get_onboarding_summary with a comment saying "Only admins can call
-- it" and then granted EXECUTE to `authenticated`, which is every signed-in student.
-- 0022 got this right for encrypt_banking_request (revoke from public, grant to
-- service_role); this migration applies that same shape to the two that missed it.
--
-- WHAT WAS REACHABLE
--   encrypt_bam_banking: a signed-in student knows their own bams.id, so they could
--   rewrite their own institution/transit/account with no admin review. That is
--   precisely what /portal/account is designed to prevent ("You cannot edit it here
--   on purpose") and what the banking-change queue exists to gate. Other people's
--   rows need their uuid, which RLS does not hand out, so the practical exposure is
--   self-service payout redirection rather than mass tampering.
--
--   get_onboarding_summary: anonymous. No account needed.
--
-- Belt and braces on purpose: the REVOKE removes the door, and the in-function guard
-- means a future accidental GRANT is not sufficient by itself. decrypt_bam_banking
-- already had the guard, which is why it held even though its grant was open too.

-- ── 1. encrypt_bam_banking ──────────────────────────────────────────────────
-- Same signature as 0003. Body unchanged except for the caller check.
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
  -- Mirrors decrypt_bam_banking. Admins reach this through a reviewed route
  -- (banking-requests/decide); everything else must be the service role.
  if current_role_claim() not in ('super_admin','program_admin') and
     coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role' then
    raise exception 'not authorized to write banking';
  end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'blu_banking_key'
  limit 1;

  if v_key is null then
    raise exception 'blu_banking_key not found in vault; provision via dashboard';
  end if;

  -- A null argument means "leave this column alone" (relied on by the banking
  -- restore path and by scripts/probe/fix-test-bank-institution.js).
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

revoke all on function encrypt_bam_banking(uuid, text, text, text, text) from public;
revoke all on function encrypt_bam_banking(uuid, text, text, text, text) from anon;
revoke all on function encrypt_bam_banking(uuid, text, text, text, text) from authenticated;
grant execute on function encrypt_bam_banking(uuid, text, text, text, text) to service_role;

comment on function encrypt_bam_banking is
  'Encrypted banking write. service_role or an admin claim only (0024). '
  'CREATE FUNCTION defaults to EXECUTE TO PUBLIC, so the grant is the security '
  'boundary, not the comment above it.';

-- ── 2. decrypt_bam_banking ──────────────────────────────────────────────────
-- Its internal guard already held, so this only removes the open door. The body is
-- deliberately NOT redefined here: it works, and rewriting it would risk a typo in
-- the one function that guards banking reads.
revoke all on function decrypt_bam_banking(uuid) from public;
revoke all on function decrypt_bam_banking(uuid) from anon;
revoke all on function decrypt_bam_banking(uuid) from authenticated;
grant execute on function decrypt_bam_banking(uuid) to service_role;

-- ── 3. get_onboarding_summary ───────────────────────────────────────────────
-- Nothing in app/, lib/ or supabase/ calls this function; 0013 created it as a
-- convenience and no UI ever used it. It is kept rather than dropped so that a
-- future admin queue can use it, but it is now reachable only by the service role
-- and it checks the caller itself.
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
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if current_role_claim() <> 'super_admin' and
     coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role' then
    raise exception 'not authorized to read onboarding submissions';
  end if;

  return query
    select s.id, s.submitted_email, s.matched_bam_id, s.status, s.flag_reason,
           s.submitted_at, s.resolved_at, s.purge_at
    from onboarding_submissions s
    order by s.submitted_at desc;
end $$;

revoke all on function get_onboarding_summary() from public;
revoke all on function get_onboarding_summary() from anon;
revoke all on function get_onboarding_summary() from authenticated;
grant execute on function get_onboarding_summary() to service_role;

comment on function get_onboarding_summary is
  'Parked onboarding submissions. super_admin claim or service_role only (0024). '
  'It was granted to `authenticated` — every signed-in student — and returned '
  'submitted_email and flag_reason to a caller with no session at all.';

-- ── 4. Verify, and refuse to finish if the doors are still open ─────────────
-- A migration that reports success without checking is the failure mode this
-- codebase keeps hitting. has_function_privilege is checked for each open role.
do $$
declare
  v_bad text := '';
begin
  if has_function_privilege('anon', 'encrypt_bam_banking(uuid,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'encrypt_bam_banking(uuid,text,text,text,text)', 'execute') then
    v_bad := v_bad || 'encrypt_bam_banking ';
  end if;
  if has_function_privilege('anon', 'decrypt_bam_banking(uuid)', 'execute')
     or has_function_privilege('authenticated', 'decrypt_bam_banking(uuid)', 'execute') then
    v_bad := v_bad || 'decrypt_bam_banking ';
  end if;
  if has_function_privilege('anon', 'get_onboarding_summary()', 'execute')
     or has_function_privilege('authenticated', 'get_onboarding_summary()', 'execute') then
    v_bad := v_bad || 'get_onboarding_summary ';
  end if;

  if v_bad <> '' then
    raise exception 'Grants still open to anon/authenticated for: %', v_bad;
  end if;

  raise notice '0024: encrypt_bam_banking, decrypt_bam_banking, get_onboarding_summary are service_role only';
end $$;
