-- 0029 — a rehearsal must not consume the real send. AUDIT-2026-08-13 finding 6.
--
-- WHAT WAS WRONG
-- --------------
-- 0025 made the idempotency key (bam_id, period, kind). The mode the reminder ran in was
-- recorded on the row but was NOT part of the key, and `lib/run-student-reminders.ts` looked up
-- "who was already reminded" with the same three columns.
--
-- So a DRAFT run inserts a row for every selected student and sends nothing, which is exactly
-- what draft is for. Then the live run finds those rows, treats every one of those students as
-- already reminded, and sends ZERO emails. The cron reports success both times.
--
-- The Settings page recommends running draft first. Following the instructions was the bug.
--
-- This is the worst shape a fault can have in this program: the rehearsal passes and the real
-- run silently does nothing, so nobody goes looking. Same class as the AP dry-run divergence
-- that prompted the audit.
--
-- THE FIX
-- -------
-- Put `mode` in the key, which is what `lib/send-guard.ts` already does for invoice sends
-- (mode is part of the claim there, so draft-then-live works by design). What each mode is
-- allowed once per period is then its own thing:
--
--   draft on the 10th   -> one draft row     -> nothing sent
--   live  on the 10th   -> one live row      -> ONE email
--   live  on the 14th   -> refused by the index, still one email for the period
--
-- A second live run is still blocked, which is the property 0025 was written to guarantee and
-- the only one that actually protects a student's inbox.
--
-- SAFE TO RUN: student_reminders had 0 rows when this was written, so no existing record
-- changes meaning. The old index is dropped and replaced in one statement pair; if that ever
-- runs against a populated table, the new index is WIDER (more columns), so it cannot fail on
-- data the old one allowed.

drop index if exists student_reminders_once;

create unique index if not exists student_reminders_once
  on student_reminders (bam_id, period, kind, mode);

-- ── Read back ─────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS and CREATE INDEX IF NOT EXISTS both report success when they do
-- nothing, so "it ran" is not evidence that the key changed. This checks the actual column
-- list, and refuses to finish if `mode` is not in it.

do $chk$
declare
  v_cols text;
begin
  select string_agg(a.attname, ',' order by k.ord)
    into v_cols
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
  where c.relname = 'student_reminders_once';

  if v_cols is null then
    raise exception 'student_reminders_once does not exist after this migration';
  end if;

  if v_cols <> 'bam_id,period,kind,mode' then
    raise exception 'student_reminders_once is on (%), expected (bam_id,period,kind,mode)', v_cols;
  end if;

  if not exists (
    select 1 from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.relname = 'student_reminders_once' and i.indisunique
  ) then
    raise exception 'student_reminders_once is no longer UNIQUE, which removes the guard entirely';
  end if;

  raise notice '0029: student_reminders_once is now unique on (bam_id, period, kind, mode)';
end $chk$;
