-- Paste into the Supabase SQL editor and Run.
-- Relaxes the banking-change reason from a 10-character minimum to just non-blank.
begin;

-- 0023_relax_banking_request_reason.sql
--
-- The banking-change reason had a 10-character minimum, in the form, in
-- lib/banking-request.ts and in this CHECK. Ten was an arbitrary number and it
-- rejected perfectly good answers: "typo", "wrong bank", "new account". The form
-- also gave no indication of why the Send button was disabled, so a student would
-- just be stuck looking at a greyed-out button.
--
-- Still required, still non-blank: Robin needs to know why a payout destination is
-- being changed, and that sentence is what lands in the audit trail. But any real
-- answer is now accepted.
--
-- The app constant and this constraint must move together. Relaxing only the app
-- would mean the form accepts "typo" and the insert then fails on the constraint,
-- which is the app-allows / database-rejects split that caused several of the other
-- defects found this week.

alter table banking_change_requests
  drop constraint if exists bcr_reason_not_empty;

alter table banking_change_requests
  add constraint bcr_reason_not_empty
  check (length(btrim(reason)) >= 1);

do $$
declare
  n int;
begin
  select count(*) into n from banking_change_requests where length(btrim(reason)) < 10;
  raise notice 'banking_change_requests with a reason under 10 chars: % (these are now allowed)', n;
end $$;


insert into supabase_migrations.schema_migrations (version)
values ('0023')
on conflict (version) do nothing;

commit;
