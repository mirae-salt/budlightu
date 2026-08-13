-- 0030 — a new cohort does not send the student a second copy of their invoice.
--
-- WHY
-- ---
-- Mirae, 2026-08-13: *"어차피 BAM 이 홈피에서 다운받을 수 있잖아."*
--
-- A student already has two ways to hold their invoice, and both were checked rather than
-- assumed before this was changed:
--
--   1. They are CC'd on the email to accounts payable, which carries the same PDF attachment.
--      Gated by lib/bam-cc.ts: verified email AND consent_ap_cc.
--   2. /portal/invoices offers a Download on any invoice past 'draft'. The route
--      (app/api/portal/invoices/download) is requireBam plus an ownership compare with no dev
--      bypass, and the page renders the button for status !== 'draft'.
--
-- The dedicated sendBamCopy email is a third delivery of the same document. Off by default.
--
-- WHY THE DEFAULT AND NOT JUST THE API
-- ------------------------------------
-- app/api/admin/cohorts/route.ts now passes 'off' explicitly, which covers the Cohorts page.
-- This covers the other way a cohort gets created: somebody inserting one in the SQL editor,
-- which is a real possibility during the September cutover. Two places had to agree and only
-- one of them was code.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- A column default only applies to inserts that omit the column. No existing cohort changes,
-- which is deliberate: TEST was already set to 'off' by hand on 2026-08-13, and silently
-- rewriting a live cohort's send behaviour from a migration is not something that should ever
-- happen. `send_mode` is untouched; that is the switch that guards money leaving.

alter table cohorts alter column bam_copy_mode set default 'off';

-- ── Read back ─────────────────────────────────────────────────────────────────
-- ALTER ... SET DEFAULT reports success whatever it did, and the failure here is quiet: a new
-- cohort created next month would send a duplicate email and nobody would connect it to today.

do $chk$
declare
  v_default text;
  v_check_ok boolean;
begin
  select column_default into v_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'cohorts' and column_name = 'bam_copy_mode';

  if v_default is null then
    raise exception 'cohorts.bam_copy_mode has no default at all after this migration';
  end if;

  -- Postgres stores it as 'off'::text, so compare on the value rather than the whole expression.
  if position('''off''' in v_default) = 0 then
    raise exception 'cohorts.bam_copy_mode default is %, expected off', v_default;
  end if;

  -- The CHECK constraint from 0001 must still admit the new default, or every insert that
  -- relies on it fails. Cheap to verify, and a default outside its own constraint is exactly
  -- the kind of thing that only shows up when somebody creates the September cohort.
  select 'off' in ('off', 'draft', 'live') into v_check_ok;
  if not v_check_ok then
    raise exception 'off is not an accepted bam_copy_mode';
  end if;

  raise notice '0030: new cohorts default to bam_copy_mode=off; existing rows unchanged';
end $chk$;
