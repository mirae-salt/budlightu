-- Support questions become threads.
--
-- WHAT WAS WRONG
-- --------------
-- `portal_questions` is one row per question with a single `answer` column, so a follow-up from the
-- student created a SEPARATE, unrelated row. Neither the admin nor the student had any way to see
-- that two cards were the same conversation, and a second reply from Robin would have overwritten
-- the first. Mirae, 2026-08-13: "근데 이러면 스레드가 아니지않나? 계속 이어지는 질문이면?" Correct.
--
-- WHY A CHILD TABLE AND NOT A JSON ARRAY ON THE ROW
-- ------------------------------------------------
-- Each message needs its own author and its own timestamp, because "who said what when" is the
-- question anyone asks of a support thread later. A JSON array can hold that, but it cannot be
-- indexed, cannot be constrained, and cannot carry an RLS policy of its own. The unread/notified
-- bookkeeping also belongs per message, not per thread.
--
-- `portal_questions.question` and `.answer` are LEFT ALONE. They are backfilled into this table
-- below and kept in sync by the application, so nothing that reads them breaks, and this migration
-- is reversible by dropping one table.

create table if not exists portal_question_messages (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references portal_questions(id) on delete cascade,
  -- 'bam' or 'admin'. Text with a CHECK rather than an enum, matching receipts.status: adding a
  -- third author later (a system note, say) should not need a migration.
  author text not null check (author in ('bam', 'admin')),
  -- Who actually wrote it, when it was an admin. Null for a BAM message: the thread's bam_id
  -- already says who that is, and a student has no auth row worth pointing at from here.
  author_user_id uuid references auth.users(id) on delete set null,
  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

-- Reading a thread is always "every message for this question, oldest first".
create index if not exists pqm_thread on portal_question_messages (question_id, created_at);

-- ── Backfill ──────────────────────────────────────────────────────────────────
-- Every existing question becomes its first message, and every existing answer the second. Without
-- this, threads created before today would render empty and look like data loss.
--
-- Guarded by NOT EXISTS so re-running the migration cannot duplicate a message.

insert into portal_question_messages (question_id, author, body, created_at)
select q.id, 'bam', q.question, q.submitted_at
from portal_questions q
where trim(coalesce(q.question, '')) <> ''
  and not exists (
    select 1 from portal_question_messages m
    where m.question_id = q.id and m.author = 'bam'
  );

insert into portal_question_messages (question_id, author, author_user_id, body, created_at)
select q.id, 'admin', q.answered_by, q.answer, coalesce(q.answered_at, now())
from portal_questions q
where trim(coalesce(q.answer, '')) <> ''
  and not exists (
    select 1 from portal_question_messages m
    where m.question_id = q.id and m.author = 'admin'
  );

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- A student may read and append to their OWN thread. Nothing else.
alter table portal_question_messages enable row level security;

do $rls$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'portal_question_messages' and policyname = 'pqm_bam_read_own'
  ) then
    create policy pqm_bam_read_own on portal_question_messages
      for select using (
        exists (
          select 1 from portal_questions q
          join bams b on b.id = q.bam_id
          where q.id = portal_question_messages.question_id
            and b.auth_user_id = auth.uid()
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'portal_question_messages' and policyname = 'pqm_admin_read'
  ) then
    create policy pqm_admin_read on portal_question_messages
      for select using (
        coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'super_admin', 'program_admin')
      );
  end if;
end $rls$;

-- ── Read back ─────────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS reports success when it does nothing, and a silently absent table
-- would make every thread render as one lonely message with no error anywhere.

do $chk$
declare
  n_msgs integer;
  n_qs integer;
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'portal_question_messages'
  ) then
    raise exception 'portal_question_messages was not created';
  end if;

  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'pqm_thread'
  ) then
    raise exception 'pqm_thread index is missing';
  end if;

  -- Every question with text must now have at least one message, or the backfill did not run.
  select count(*) into n_qs
  from portal_questions q
  where trim(coalesce(q.question, '')) <> ''
    and not exists (select 1 from portal_question_messages m where m.question_id = q.id);
  if n_qs > 0 then
    raise exception '% question(s) have no messages after backfill', n_qs;
  end if;

  select count(*) into n_msgs from portal_question_messages;
  raise notice 'portal_question_messages ready with % row(s)', n_msgs;
end $chk$;
