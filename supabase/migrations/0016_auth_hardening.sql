-- ============================================================================
-- 0016_auth_hardening.sql
--
-- NOTE ON NUMBERING: the brief asked for `0015_auth_hardening.sql`, but
-- 0015_bams_is_test.sql already exists on main. Renumbered to 0016 so the
-- existing migration is not overwritten and ordering stays deterministic.
--
-- WRITTEN, NOT APPLIED. Nothing here has been run against any database.
-- Apply with `supabase db push` AFTER reading section 5: existing admins must
-- sign out and sign in again or they lose /admin access.
--
-- Fixes:
--   P0-A  current_role_claim() reads the client-writable user_metadata bag
--   P0-A  backfill: copy existing role / bam_id claims into app_metadata
--   P1-6  roster email stored unnormalized -> permanent BAM lockout
--
-- STYLE NOTE: every invisible character in this file is written as chr(NNNNN),
-- never as a literal. A literal BOM or zero-width space pasted into a migration
-- is invisible in the diff and in review, which is the exact failure mode this
-- migration exists to fix.
-- ============================================================================


-- ============================================================================
-- 1. P0-A: the role claim moves to app_metadata
-- ============================================================================
-- WHY: `user_metadata` (auth.users.raw_user_meta_data) is writable by the user's
-- own session with nothing but the anon key:
--
--     await supabase.auth.updateUser({ data: { role: 'super_admin' } })
--
-- Migration 0012 pointed current_role_claim() at that bag, which made every RLS
-- policy in 0002 / 0003 / 0004 / 0013 self-assignable. A student could
-- self-promote and then call decrypt_bam_banking() to read all 58 BAMs' transit
-- and account numbers in plaintext.
--
-- `app_metadata` (auth.users.raw_app_meta_data) can only be written with the
-- service role key. There is deliberately NO fallback to user_metadata: a
-- fallback would restore the hole. An absent claim resolves to 'bam', the
-- least-privileged role, so the failure direction is "denied".
create or replace function current_role_claim() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(auth.jwt()->'app_metadata'->>'role', ''),
    'bam'
  )
$$;

comment on function current_role_claim() is
  'Trusted role claim. Reads app_metadata ONLY (service-role writable). Never read user_metadata here: the user can write it with the anon key (P0-A, audit 2026-08-07). An absent claim resolves to the least-privileged role.';


-- ============================================================================
-- 2. P0-A: assert the claim source so a future migration cannot regress it
-- ============================================================================
-- A one-line "fix" that reintroduces user_metadata is exactly how this bug got in
-- (0012). This refuses to apply if the function body is wrong.
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'current_role_claim';

  if v_src is null then
    raise exception 'current_role_claim() not found';
  end if;
  if v_src like '%user_metadata%' then
    raise exception 'current_role_claim() still references user_metadata, which the client can write. Refusing to apply.';
  end if;
  if v_src not like '%app_metadata%' then
    raise exception 'current_role_claim() does not read app_metadata. Refusing to apply.';
  end if;
end $$;


-- ============================================================================
-- 3. P0-A: idempotent backfill of existing claims into app_metadata
-- ============================================================================
-- Runs as the migration role, which is the only way to write app_metadata
-- without going through the Admin API.
--
-- 3a. Admin roles. Only 'program_admin' and 'super_admin' are copied, and ONLY
--     when app_metadata carries no role yet, so re-running can never resurrect a
--     role that was deliberately revoked afterwards.
with promoted as (
  update auth.users u
  set raw_app_meta_data =
        coalesce(u.raw_app_meta_data, '{}'::jsonb)
        || jsonb_build_object('role', u.raw_user_meta_data->>'role')
  where u.raw_user_meta_data->>'role' in ('program_admin', 'super_admin')
    and coalesce(u.raw_app_meta_data->>'role', '') = ''
  returning u.id, u.email, u.raw_user_meta_data->>'role' as role
)
insert into audit_log (actor_role, entity, entity_id, action, after_json)
select 'system', 'auth_claim', p.id, 'backfill_role_to_app_metadata',
       jsonb_build_object('email', p.email, 'role', p.role, 'migration', '0016')
from promoted p;

-- 3b. BAM role. Same rule: never overwrite an existing app_metadata role. That is
--     what protects an admin who also appears on the BAM roster (P1-17b).
update auth.users u
set raw_app_meta_data =
      coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'bam')
where u.raw_user_meta_data->>'role' = 'bam'
  and coalesce(u.raw_app_meta_data->>'role', '') = '';

-- 3c. Anyone linked to a bams row but carrying no role at all.
update auth.users u
set raw_app_meta_data =
      coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'bam')
where coalesce(u.raw_app_meta_data->>'role', '') = ''
  and exists (select 1 from bams b where b.auth_user_id = u.id);

-- 3d. bam_id claim, taken from the bams table (authoritative) rather than from
--     user_metadata, because user_metadata.bam_id was equally forgeable:
--     /api/verify-account/tail trusted it and would happily return another BAM's
--     account tail (P0-A step 5).
update auth.users u
set raw_app_meta_data =
      coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('bam_id', b.id::text)
from bams b
where b.auth_user_id = u.id
  and coalesce(u.raw_app_meta_data->>'bam_id', '') is distinct from b.id::text;

-- 3e. Report. psql prints these NOTICEs. Read them (ENGINEERING-RULES 3).
do $$
declare
  v_app_admins  int;
  v_meta_admins int;
  v_orphans     int;
begin
  select count(*) into v_app_admins
    from auth.users where raw_app_meta_data->>'role' in ('program_admin','super_admin');
  select count(*) into v_meta_admins
    from auth.users where raw_user_meta_data->>'role' in ('program_admin','super_admin');
  select count(*) into v_orphans
    from auth.users u
    where u.raw_user_meta_data->>'role' in ('program_admin','super_admin')
      and coalesce(u.raw_app_meta_data->>'role','') not in ('program_admin','super_admin');

  raise notice '[0016] admins with a trusted app_metadata role: %', v_app_admins;
  raise notice '[0016] users still carrying a legacy user_metadata admin role: %', v_meta_admins;
  raise notice '[0016] legacy admin roles NOT mirrored (revoked or intentionally absent): %', v_orphans;
  raise notice '[0016] ACTION REQUIRED: existing sessions hold the OLD JWT. Every admin must sign out and sign in again before /admin will let them through.';

  if v_app_admins = 0 then
    raise warning '[0016] No user has an admin role in app_metadata. /admin is now locked for everyone. See section 5(b) to grant the first one.';
  end if;
end $$;

-- 3f. Legacy cleanup is INTENTIONALLY NOT DONE here. Leaving user_metadata.role
--     in place is harmless now (nothing reads it for authorization) and it is the
--     only record of who held what if the backfill needs re-examining. Clear it
--     after the app-side sweep is confirmed:
--       update auth.users set raw_user_meta_data = raw_user_meta_data - 'role';


-- ============================================================================
-- 4. P1-6: email normalization enforced in the database
-- ============================================================================
-- WHY: the roster PATCH route stored `email` verbatim while the login path looked
-- it up with `.trim().toLowerCase()`. Pasting "Lucas.Grabowski@uwo.ca", or a value
-- with a trailing space, permanently locked that BAM out of login, receipt upload
-- and payment with no signal anywhere. The unique index is on lower(email), so it
-- was case-safe but not whitespace-safe. This has already happened in production.
--
-- The route now normalizes. This trigger is the backstop: no future route, CSV
-- import or manual UPDATE can reintroduce it.

-- One definition of "canonical email", shared by the trigger and the repair query
-- below so the two can never disagree. Mirrors normalizeEmail() in lib/sanitize.ts.
create or replace function canonical_email(p_email text) returns text
language sql immutable set search_path = public as $$
  select lower(
    regexp_replace(
      translate(
        p_email,
        -- BOM / ZWNBSP
        chr(65279)
        -- zero-width space, ZWNJ, ZWJ, LRM, RLM
        || chr(8203) || chr(8204) || chr(8205) || chr(8206) || chr(8207)
        -- bidi embeddings and overrides (U+202A..U+202E)
        || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238)
        -- word joiner, bidi isolates (U+2060, U+2066..U+2069)
        || chr(8288) || chr(8294) || chr(8295) || chr(8296) || chr(8297)
        -- soft hyphen, NBSP, narrow NBSP, ideographic space
        || chr(173) || chr(160) || chr(8239) || chr(12288),
        ''
      ),
      -- Then every remaining whitespace or control character. An email address can
      -- never legitimately contain one. btrim() would only handle the ends, and it
      -- does not touch U+200B at all.
      '[[:space:][:cntrl:]]', '', 'g'
    )
  )
$$;

comment on function canonical_email(text) is
  'Canonical form of an email for storage and lookup: removes invisible characters (BOM, zero-width, bidi, NBSP), all whitespace and control characters, then lowercases. Must stay in step with normalizeEmail() in lib/sanitize.ts.';

create or replace function normalize_bam_email() returns trigger
language plpgsql set search_path = public as $$
declare
  v_clean text;
begin
  if new.email is null then
    return new;
  end if;

  v_clean := canonical_email(new.email);

  if v_clean = '' then
    raise exception 'email cannot be blank after normalization (original: %)', new.email;
  end if;

  -- Deliberately loose shape check. The application does the strict validation;
  -- this only catches values that could never be delivered at all.
  if v_clean !~ '^[^@]+@[^@.]+([.][^@.]+)+$' then
    raise exception 'email % is not a deliverable address', new.email;
  end if;

  if v_clean <> new.email then
    raise notice 'normalized bams.email from % to %', new.email, v_clean;
  end if;

  new.email := v_clean;
  return new;
end $$;

drop trigger if exists bams_normalize_email on bams;
create trigger bams_normalize_email
  before insert or update of email on bams
  for each row execute function normalize_bam_email();

comment on function normalize_bam_email() is
  'P1-6 backstop: forces bams.email into the canonical form the login path looks up. An unnormalized email is a permanent BAM lockout (already hit in production).';

-- 4b. Repair rows already stored unnormalized. Assigning email to itself lets the
--     trigger do the work, so there is exactly one normalization implementation.
--     Guarded so nothing is rewritten needlessly (no spurious updated_at churn).
update bams
set email = email
where email is not null
  and email <> canonical_email(email);

do $$
declare v_bad int;
begin
  select count(*) into v_bad
  from bams
  where email is not null and email <> canonical_email(email);
  raise notice '[0016] bams rows still holding a non-canonical email after repair: % (expected 0)', v_bad;
end $$;


-- ============================================================================
-- 5. HUMAN STEPS AFTER APPLYING THIS MIGRATION
-- ============================================================================
-- (a) Every existing session holds a JWT minted from the OLD metadata. The new
--     claim only appears after a token refresh. Robin, Jenna, Nathan and Mirae
--     must SIGN OUT AND SIGN IN AGAIN or they will be bounced out of /admin.
--
-- (b) Read the NOTICE output from 3e. If "admins with a trusted app_metadata role"
--     is 0, nobody can reach /admin. Grant the first one out of band and then READ
--     IT BACK (ENGINEERING-RULES 1):
--       update auth.users
--          set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb)
--                                  || '{"role":"super_admin"}'::jsonb
--        where email = 'mirae.lee@ilovesalt.com';
--       select email, raw_app_meta_data->>'role' from auth.users
--        where email = 'mirae.lee@ilovesalt.com';
--     Preferred alternative once one super_admin exists: the /admin team UI, which
--     verifies the grant by reading the user back.
--
-- (c) Verify the claim reaches the JWT. Supabase includes app_metadata in the
--     access token by default, but if this project ever gains a custom access
--     token hook, confirm it still passes app_metadata through, otherwise every
--     admin RLS policy will deny. Sign in, then:
--       select current_role_claim();
--
-- (d) This migration does NOT clear legacy user_metadata.role. See 3f.
