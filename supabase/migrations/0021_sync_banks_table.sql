-- 0021_sync_banks_table.sql
--
-- Make the `banks` table match lib/banks.ts exactly.
--
-- WHY THIS IS NEEDED
-- ------------------
-- 0020 corrected nine wrong institution numbers with statements like
--   update banks set institution_no = '837' where name_normalized = 'meridian';
-- Those matched ZERO rows and silently did nothing, because the version of
-- 0005_seed_banks.sql that was actually applied to this database is older than the
-- one in the repo and never contained the credit unions at all. An UPDATE that
-- matches no rows is not an error, so 0020 reported success while changing
-- nothing. (Verified by dumping the table, not by reading the migration.)
--
-- WHY IT IS NOT AN OUTAGE
-- -----------------------
-- Nothing reads this table. Every code path uses BANK_SEED / lookupBank from
-- lib/banks.ts: the onboarding dropdowns, the roster dropdown, and the hard-fail
-- lookup in both onboarding handlers. The corrected numbers are therefore already
-- live in the deployed code. This migration removes the divergence so the table
-- cannot later be mistaken for a source of truth.
--
-- It also drops two DEAD institutions the old seed still carried:
--   hsbc            016  acquired by RBC, migrated 2024-03-29  -> use RBC 003
--   canadian western 030 acquired by National Bank, closed 2025 -> use National 006
-- A dead code is worse than a missing one: it passes every format check and routes
-- into a closed clearing lane, whereas an unlisted bank hard-fails to a human.
--
-- Generated from BANK_SEED so the two cannot disagree. If you edit lib/banks.ts,
-- regenerate this list rather than hand-editing it.

delete from banks;

insert into banks (name_normalized, institution_no, display_name) values
  ('bmo', '001', 'BMO Bank of Montreal'),
  ('scotiabank', '002', 'Scotiabank'),
  ('rbc', '003', 'RBC Royal Bank'),
  ('td', '004', 'TD Canada Trust'),
  ('national', '006', 'National Bank of Canada'),
  ('cibc', '010', 'CIBC'),
  ('simplii', '010', 'Simplii Financial'),
  ('laurentian', '039', 'Laurentian Bank'),
  ('atb', '219', 'ATB Financial'),
  ('first nations', '310', 'First Nations Bank of Canada'),
  ('pc financial', '320', 'President''s Choice Financial'),
  ('canadian tire', '338', 'Canadian Tire Bank'),
  ('manulife', '540', 'Manulife Bank'),
  ('tangerine', '614', 'Tangerine'),
  ('alterna bank', '608', 'Alterna Bank'),
  ('peoples trust', '621', 'Peoples Trust'),
  ('eq bank', '623', 'EQ Bank (Equitable Bank)'),
  ('wealthsimple', '703', 'Wealthsimple'),
  ('desjardins', '815', 'Desjardins'),
  ('desjardins ontario', '829', 'Desjardins Ontario Credit Union'),
  ('uni', '865', 'UNI Financial Cooperation'),
  ('caisse alliance', '890', 'Caisse Alliance'),
  ('vancity', '809', 'Vancity'),
  ('coast capital', '809', 'Coast Capital Savings'),
  ('libro', '828', 'Libro Credit Union'),
  ('meridian', '837', 'Meridian Credit Union'),
  ('alterna savings', '842', 'Alterna Savings'),
  ('scu', '879', 'SCU (Steinbach Credit Union)'),
  ('affinity', '889', 'Affinity Credit Union'),
  ('conexus', '889', 'Conexus Credit Union'),
  ('connectfirst', '899', 'connectFirst Credit Union'),
  ('servus', '899', 'Servus Credit Union')
on conflict (name_normalized) do update set
  institution_no = excluded.institution_no,
  display_name   = excluded.display_name;

do $$
declare
  n_total int;
  n_dead  int;
begin
  select count(*) into n_total from banks;
  select count(*) into n_dead  from banks where institution_no in ('016', '030', '374');
  raise notice 'banks: % rows, % dead institutions (expect 32 and 0)', n_total, n_dead;
end $$;
