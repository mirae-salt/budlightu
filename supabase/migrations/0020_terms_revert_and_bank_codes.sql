-- 0020_terms_revert_and_bank_codes.sql
--
-- Three unrelated corrections, all from the 2026-08-07 review:
--   1. T&C acceptance was collected in the UI and never stored.
--   2. Receipt decisions could not be reverted, so a mis-click was permanent.
--   3. Nine of 22 bank institution numbers were wrong.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Record T&C acceptance
--
-- The onboarding form has always had a "I accept the terms" checkbox that gates
-- the submit button, but `consent_terms` was never sent to or stored by the
-- server. Shane's stated reason for the checkbox on 2026-08-04 was that it
-- "acts as a digital record", which it could not do. If a BAM disputes a
-- forfeited reimbursement there was no record they agreed to anything.
--
-- The version string is stored alongside the timestamp so that changing the
-- terms later does not silently reinterpret an old acceptance.
-- ─────────────────────────────────────────────────────────────────────────────
alter table bams add column if not exists consent_terms_at timestamptz;
alter table bams add column if not exists consent_terms_version text;

comment on column bams.consent_terms_at is
  'When the BAM accepted the program terms during onboarding. NULL = never accepted.';
comment on column bams.consent_terms_version is
  'Which terms revision was accepted, so a later revision cannot reinterpret it.';

-- These are system-controlled: a BAM must never be able to backdate or forge
-- their own consent, and an admin must not be able to set it on their behalf.
-- Mirrors the existing guard pattern from 0004_system_field_triggers.sql.
create or replace function bams_protect_consent() returns trigger
language plpgsql as $$
begin
  if current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role' then
    return new;
  end if;
  if new.consent_terms_at is distinct from old.consent_terms_at
     or new.consent_terms_version is distinct from old.consent_terms_version then
    raise exception 'bams consent fields are set by the onboarding flow only';
  end if;
  return new;
end $$;

drop trigger if exists bams_lock_consent on bams;
create trigger bams_lock_consent
  before update on bams
  for each row execute function bams_protect_consent();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Allow a receipt decision to be reverted
--
-- `receipts.status` had no way back: decide() accepted only pending/review/
-- ocr_failed, the admin queue listed only review/ocr_failed, and the sha256
-- uniqueness index blocked re-uploading the same photo. So a mis-clicked Reject
-- cost the student $150 with no recourse, and the admin UI's "revert" button
-- only mutated local React state and silently did nothing.
--
-- No schema change is needed for the status itself (the CHECK already permits
-- the earlier values); what was missing is an audit trail for the revert and a
-- record of how many times a receipt has been reopened.
-- ─────────────────────────────────────────────────────────────────────────────
alter table receipts add column if not exists reverted_count int not null default 0;
alter table receipts add column if not exists reverted_at timestamptz;
alter table receipts add column if not exists reverted_by uuid;

comment on column receipts.reverted_count is
  'How many times this receipt decision has been reopened. Non-zero is worth a look.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Correct the bank institution numbers
--
-- The original list came from Interac Sign-In partners, which is a login
-- federation list and says nothing about which central a credit union clears
-- through. Seven credit unions were seeded as 839 (Atlantic Central) and two
-- caisses as 815 (Desjardins Quebec). Both are LIVE institution numbers, so a
-- payment would pass every format check and enter the wrong clearing stream
-- carrying a transit that does not exist there.
--
-- Canada has one central per region: 809 Central 1 BC, 828 Central 1 Ontario,
-- 839/849 Atlantic Central, 879 Manitoba, 889 Saskatchewan, 899 Alberta. Some
-- credit unions hold their own number, for which the central default is wrong.
--
-- Each value below was verified against the institution's own direct-deposit
-- page plus an independent routing database. Mirrors lib/banks.ts.
-- ─────────────────────────────────────────────────────────────────────────────
update banks set institution_no = '889' where name_normalized = 'affinity';        -- was 839
update banks set institution_no = '889' where name_normalized = 'conexus';         -- was 839
update banks set institution_no = '899' where name_normalized = 'connectfirst';    -- was 839
update banks set institution_no = '899' where name_normalized = 'servus';          -- was 839
update banks set institution_no = '828' where name_normalized = 'libro';           -- was 839
update banks set institution_no = '837' where name_normalized = 'meridian';        -- was 839, own number
update banks set institution_no = '879' where name_normalized = 'scu';             -- was 839
update banks set institution_no = '890' where name_normalized = 'caisse alliance'; -- was 815
update banks set institution_no = '865' where name_normalized = 'uni';             -- was 815

-- Institutions students plausibly bank with that were missing. An unlisted bank
-- hard-fails safely, so these were blocked invoices rather than misroutes.
insert into banks (name_normalized, institution_no, display_name) values
  ('laurentian',         '039', 'Laurentian Bank'),
  ('first nations',      '310', 'First Nations Bank of Canada'),
  ('pc financial',       '320', 'President''s Choice Financial'),
  ('canadian tire',      '338', 'Canadian Tire Bank'),
  ('manulife',           '540', 'Manulife Bank'),
  ('alterna bank',       '608', 'Alterna Bank'),
  ('peoples trust',      '621', 'Peoples Trust'),
  ('eq bank',            '623', 'EQ Bank (Equitable Bank)'),
  ('desjardins ontario', '829', 'Desjardins Ontario Credit Union'),
  ('alterna savings',    '842', 'Alterna Savings')
on conflict (name_normalized) do update set
  institution_no = excluded.institution_no,
  display_name   = excluded.display_name;

-- Deliberately NOT added, because a dead code routes into a closed clearing lane
-- while an unlisted name hard-fails safely and reaches a human:
--   HSBC Canada 016      -> acquired by RBC, migrated 2024-03-29. Use RBC 003.
--   Canadian Western 030 -> acquired by National Bank, closed 2025. Use 006.
--   motusbank 374        -> wound down into Meridian. Use Meridian 837.

do $$
declare
  n_839 int;
begin
  select count(*) into n_839 from banks where institution_no = '839';
  raise notice 'banks still on 839 (Atlantic Central): % — expected 0 until a genuine Atlantic credit union is added', n_839;
  raise notice 'ACTION REQUIRED: Salt finance/AP must confirm these 3-digit codes before the first live payment run.';
end $$;
