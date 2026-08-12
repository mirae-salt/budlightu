-- Two things the UI has been pretending it can do, and cannot.
--
-- 1. ANSWERING A QUESTION
--    The Questions page shows a list and a mailto link. There is nowhere to record that a
--    question was dealt with, so every question stays visually identical forever and the only
--    way to know is to remember. That is also why the sidebar badge was dropped: a count with
--    no notion of "handled" only ever goes up.
--
-- 2. A STUDENT TURNING REMINDERS OFF
--    The reminder email says "you can turn these off on your account page". There was no column
--    behind that sentence, which would have made the email a lie the first time it sent.
--    Written before the switch is ever set to live, so it never gets to be one.
--
-- Both default to the state the existing rows are already in, so nothing changes for anyone
-- until someone acts.

-- ── 1. Answering ──────────────────────────────────────────────────────────────

alter table portal_questions
  add column if not exists answered_at timestamptz,
  add column if not exists answered_by uuid references auth.users(id) on delete set null,
  -- What was said back. Not required: Robin may answer in her own email client and just mark
  -- it done, and forcing her to paste a copy here is how a feature stops being used.
  add column if not exists answer text;

-- Open questions are the ones anybody looks for, so the index covers exactly those.
create index if not exists portal_questions_open
  on portal_questions (submitted_at desc)
  where answered_at is null;

-- ── 2. Reminder opt-out ───────────────────────────────────────────────────────

-- Default TRUE: opting in 58 students one by one is not a thing that would happen, and a
-- reminder is a courtesy about money they are owed. They can decline it; they should not have
-- to ask for it.
--
-- NOT NULL with a default, so `wants_reminders = false` is the only way to be excluded and a
-- null can never quietly mean "do not send" for a student who never touched the setting.
alter table bams
  add column if not exists wants_reminders boolean not null default true;

-- ── Read back ─────────────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS reports success when it does nothing. If any of these are missing
-- the app will read `undefined` and silently treat every question as open and every student as
-- opted in, so this fails loudly here instead.

do $$
declare
  missing text[] := '{}';
begin
  if not exists (select 1 from information_schema.columns
                 where table_name = 'portal_questions' and column_name = 'answered_at') then
    missing := missing || 'portal_questions.answered_at';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_name = 'portal_questions' and column_name = 'answered_by') then
    missing := missing || 'portal_questions.answered_by';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_name = 'portal_questions' and column_name = 'answer') then
    missing := missing || 'portal_questions.answer';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_name = 'bams' and column_name = 'wants_reminders') then
    missing := missing || 'bams.wants_reminders';
  end if;

  if array_length(missing, 1) > 0 then
    raise exception 'migration 0026 did not apply: missing %', array_to_string(missing, ', ');
  end if;
end $$;

-- Every existing student is opted in, which is the default above. Asserted rather than assumed,
-- because a null here would exclude somebody from a reminder they never declined.
do $$
declare
  n integer;
begin
  select count(*) into n from bams where wants_reminders is null;
  if n > 0 then
    raise exception '% roster row(s) have a null wants_reminders', n;
  end if;
end $$;
