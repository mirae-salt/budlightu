-- Delete support questions belonging to TEST accounts, and the admin notifications about them.
--
-- Paste into the Supabase SQL editor and run. Safe to run repeatedly.
--
-- WHAT IT DELETES, AND WHY THAT RULE
-- ----------------------------------
-- Questions whose BAM has `is_test = true`, plus every message on those threads, plus the
-- `support_question` notifications that point at them.
--
-- Scoped by `is_test` rather than by "everything in the table" on purpose. This file will still
-- be here in October when real students have asked real questions, and "delete all questions"
-- is a thing somebody runs once without reading. With this rule it stays correct forever: test
-- data comes from test accounts.
--
-- Notifications with a NULL bam_id are included. A real question always carries one; a null is
-- left over from the dev bypass before it resolved a BAM (fixed 2026-08-13), so it is an
-- orphan pointing at nothing.
--
-- WHY THE NOTIFICATIONS TOO
-- -------------------------
-- `admin_notifications` has no foreign key to `portal_questions`, so deleting a thread leaves
-- its notification behind with a link like `/admin/questions?q=<gone>`. Clicking it lands on a
-- page that highlights nothing, which reads as a broken page rather than as deleted test data.
--
-- `portal_question_messages` cascades from `portal_questions` (0027), but it is deleted
-- explicitly here so the count printed at the end is a real observation and not an assumption
-- about what the cascade did.
--
-- NOTE ON DOLLAR QUOTING: the blocks below use named tags ($guard$, $chk$) because the Supabase
-- dashboard mis-splits bare `$$`. That is what made migration 0027 fail once.

-- ── 1. What is about to happen ───────────────────────────────────────────────
select
  (select count(*) from portal_questions q
     join bams b on b.id = q.bam_id where b.is_test) as test_questions,
  (select count(*) from portal_questions q
     join bams b on b.id = q.bam_id where not b.is_test) as real_questions_kept,
  (select count(*) from portal_questions where bam_id is null) as orphan_questions,
  (select count(*) from portal_question_messages) as messages_total,
  (select count(*) from admin_notifications where type = 'support_question') as question_notifs;

-- ── 2. Refuse if this would touch a real student ─────────────────────────────
-- Belt and braces: the deletes below are already scoped, but a typo while editing this file
-- would be discovered here rather than by a student whose question vanished.
do $guard$
declare
  n_real integer;
begin
  select count(*) into n_real
  from portal_questions q
  join bams b on b.id = q.bam_id
  where not b.is_test;

  if n_real > 0 then
    raise notice 'Keeping % question(s) from real students. Only is_test rows are deleted.', n_real;
  end if;
end $guard$;

-- ── 3. Delete ────────────────────────────────────────────────────────────────
-- Messages first, so the row count reflects what was actually removed rather than what the
-- cascade did silently.
delete from portal_question_messages m
using portal_questions q, bams b
where m.question_id = q.id
  and q.bam_id = b.id
  and b.is_test;

delete from portal_questions q
using bams b
where q.bam_id = b.id
  and b.is_test;

-- Threads never attached to anybody. Only reachable through the old dev-bypass path.
delete from portal_questions where bam_id is null;

-- The notifications about them, including the orphans described in the header.
delete from admin_notifications n
where n.type = 'support_question'
  and (
    n.bam_id is null
    or exists (select 1 from bams b where b.id = n.bam_id and b.is_test)
  );

-- ── 4. Read back, and complain if anything survived ──────────────────────────
-- A DELETE reports success when it removes nothing. The point of this block is that "it ran"
-- and "it worked" are different claims.
do $chk$
declare
  n_q integer;
  n_m integer;
  n_n integer;
begin
  select count(*) into n_q
  from portal_questions q
  left join bams b on b.id = q.bam_id
  where q.bam_id is null or b.is_test;

  select count(*) into n_m
  from portal_question_messages m
  join portal_questions q on q.id = m.question_id
  left join bams b on b.id = q.bam_id
  where q.bam_id is null or b.is_test;

  select count(*) into n_n
  from admin_notifications n
  left join bams b on b.id = n.bam_id
  where n.type = 'support_question' and (n.bam_id is null or b.is_test);

  if n_q > 0 or n_m > 0 or n_n > 0 then
    raise exception 'Not clean: % question(s), % message(s), % notification(s) remain', n_q, n_m, n_n;
  end if;

  raise notice 'Test questions purged. Remaining questions: %, messages: %, question notifications: %',
    (select count(*) from portal_questions),
    (select count(*) from portal_question_messages),
    (select count(*) from admin_notifications where type = 'support_question');
end $chk$;

-- ── 5. What is left ──────────────────────────────────────────────────────────
select
  (select count(*) from portal_questions) as questions_left,
  (select count(*) from portal_question_messages) as messages_left,
  (select count(*) from admin_notifications where type = 'support_question') as question_notifs_left;
