-- Pre-deadline reminders to students, and the record that stops them repeating.
--
-- WHY A NEW TABLE
-- ---------------
-- `bam_warnings` looked like the place for this. It is not: warning_number and the
-- consecutive-shortfall streak that triggers a reevaluation are counted off that table, so
-- writing a routine "you have 5 days left" row into it would inflate the count that decides
-- whether a student's standing in the program gets reviewed. A reminder is not a warning.
--
-- WHAT MAKES IT IDEMPOTENT
-- ------------------------
-- The cron runs daily. Without a record, a reminder sends every single day from the 10th to
-- the 15th, which is how a helpful nudge turns into six emails nobody reads. The UNIQUE
-- constraint on (bam_id, period, kind) is the whole mechanism: the insert is attempted
-- BEFORE the send, so a duplicate is refused by the database rather than by application
-- logic that can be bypassed by two cron invocations overlapping.
--
-- `sent_at` is null until the send succeeds. A row with sent_at null and an error recorded is
-- a reminder that was claimed but never delivered, which is visible rather than silent.

create table if not exists student_reminders (
  id uuid primary key default gen_random_uuid(),
  bam_id uuid not null references bams(id) on delete cascade,
  cohort_id uuid references cohorts(id) on delete set null,
  -- First of the month, matching receipts.period and reimbursement_ledger.period.
  period date not null,
  -- 'deadline' for the pre-deadline nudge, 'shortfall' for the after-the-fact notice.
  -- Text rather than an enum so adding a kind does not need a migration, which is the
  -- pattern already used by receipts.status.
  kind text not null,
  -- What the student was told, so a question about it can be answered exactly.
  spent_cad numeric(10, 2),
  cap_cad numeric(10, 2),
  -- 'off' | 'draft' | 'live', copied from the switch at send time. A draft row proves the
  -- selection logic ran and shows who WOULD have been emailed.
  mode text not null default 'draft',
  sent_at timestamptz,
  send_error text,
  created_at timestamptz not null default now()
);

-- The load-bearing line. See the header.
create unique index if not exists student_reminders_once
  on student_reminders (bam_id, period, kind);

create index if not exists student_reminders_period
  on student_reminders (period);

-- Students never read or write this; only the service role does, from the cron. Locked
-- rather than left open, because the default for a new table is no policies AND no grants
-- revoked, and this one holds who is behind on spending.
alter table student_reminders enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'student_reminders'
      and policyname = 'student_reminders_admin_read'
  ) then
    create policy student_reminders_admin_read on student_reminders
      for select
      using (
        coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'super_admin', 'program_admin')
      );
  end if;
end $$;

-- Read back rather than trusting "CREATE ... IF NOT EXISTS" to have done anything. A
-- migration that silently no-ops leaves the reminder job with no way to avoid repeating
-- itself, and the first sign of that is a student getting six emails.
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'student_reminders'
  ) then
    raise exception 'student_reminders was not created';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'student_reminders_once'
  ) then
    raise exception 'student_reminders_once is missing, so reminders could repeat daily';
  end if;
end $$;
