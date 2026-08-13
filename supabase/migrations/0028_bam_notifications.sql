-- 0028 — the student's own notification list, for the bell in the BAM portal.
--
-- WHY A SEPARATE TABLE AND NOT `bam_id` ON admin_notifications
-- ------------------------------------------------------------
-- admin_notifications is admin-only by construction: 0014 enables RLS and creates NO policy,
-- so every read goes through a service-role route. Adding a student-readable policy to that
-- table would mean a student's query is evaluated against a table that also holds every other
-- student's rows, and one wrong policy predicate leaks the lot. CLAUDE.md's privacy constraint
-- (each BAM sees only their own) is easier to hold when the rows a student may read live in a
-- table that contains nothing else.
--
-- WHAT THIS IS FOR
-- ----------------
-- A STATUS BOARD, not an inbox: "was my receipt accepted", "did my invoice go out". Records,
-- each with a link to the page that shows the detail. It must not grow into a message surface;
-- conversations belong in portal_question_messages (0027).
--
-- `type` is free text with no CHECK, matching admin_notifications. A new notification kind
-- should not need a migration; the tone lookup in the panel component falls back to grey.

create table if not exists bam_notifications (
  id uuid primary key default gen_random_uuid(),
  bam_id uuid not null references bams(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  -- A portal route, e.g. '/portal/upload'. Never an /admin path: a student following one
  -- would land on a page the middleware refuses.
  link text,
  -- Which month it is about, when it is about a month. Lets a later deep link carry the period
  -- the way handoff 1.5 wants for the admin side.
  period date,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- Every read is "my rows, unread first, newest first".
create index if not exists bam_notif_owner on bam_notifications (bam_id, read, created_at desc);

alter table bam_notifications enable row level security;

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- The app reads and writes this through a service-role route (/api/portal/notifications),
-- scoped by auth_user_id, the same shape as /api/portal/reminders. These policies are the
-- second line: if the browser key ever queries the table directly, it still sees one person's
-- rows. Belt and braces, the same reasoning as 0024.
--
-- No insert policy and no delete policy: a student may not invent a notification saying their
-- invoice was paid, and may not destroy the record that one was sent.

do $rls$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'bam_notifications' and policyname = 'bam_notif_read_own'
  ) then
    create policy bam_notif_read_own on bam_notifications
      for select using (
        exists (
          select 1 from bams b
          where b.id = bam_notifications.bam_id
            and b.auth_user_id = auth.uid()
        )
      );
  end if;

  -- Marking read. USING picks the rows they may touch; WITH CHECK stops the update from
  -- moving a row onto somebody else's bam_id, which USING alone does not prevent.
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'bam_notifications' and policyname = 'bam_notif_mark_own'
  ) then
    create policy bam_notif_mark_own on bam_notifications
      for update using (
        exists (
          select 1 from bams b
          where b.id = bam_notifications.bam_id
            and b.auth_user_id = auth.uid()
        )
      ) with check (
        exists (
          select 1 from bams b
          where b.id = bam_notifications.bam_id
            and b.auth_user_id = auth.uid()
        )
      );
  end if;
end $rls$;

-- ── Column grants ─────────────────────────────────────────────────────────────
-- Supabase's default privileges hand `anon` and `authenticated` full CRUD on every new table
-- in public, leaving RLS as the only gate. RLS is row-level: the update policy above would let
-- a student rewrite the TITLE of their own notification, which is a record of what we told
-- them. UPDATE is therefore granted on the `read` column only, which RLS cannot express.

revoke all on bam_notifications from anon;
revoke all on bam_notifications from authenticated;
grant select on bam_notifications to authenticated;
grant update (read) on bam_notifications to authenticated;

-- Explicit rather than relying on Supabase's default privileges. notifyBam() and
-- /api/portal/notifications both run as the service role, and if this grant were ever missing
-- every notification would be dropped with a permission error in a log nobody reads.
grant all on bam_notifications to service_role;

-- ── Read back ─────────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS and CREATE POLICY inside a guard both report success when they
-- do nothing. A silently absent policy here is a privacy fault, not a cosmetic one, so this
-- block raises rather than letting the migration finish quietly.

do $chk$
declare
  n_pol integer;
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'bam_notifications'
  ) then
    raise exception 'bam_notifications was not created';
  end if;

  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'bam_notif_owner'
  ) then
    raise exception 'bam_notif_owner index is missing';
  end if;

  if not exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'bam_notifications' and rowsecurity
  ) then
    raise exception 'row level security is not enabled on bam_notifications';
  end if;

  select count(*) into n_pol from pg_policies
  where schemaname = 'public' and tablename = 'bam_notifications';
  if n_pol <> 2 then
    raise exception 'expected 2 policies on bam_notifications, found %', n_pol;
  end if;

  -- The grants are the half that RLS cannot do. Check them the same way 0024 does.
  if has_table_privilege('anon', 'bam_notifications', 'select') then
    raise exception 'anon can still read bam_notifications';
  end if;
  if has_table_privilege('authenticated', 'bam_notifications', 'insert') then
    raise exception 'authenticated can still insert into bam_notifications';
  end if;
  if has_table_privilege('authenticated', 'bam_notifications', 'delete') then
    raise exception 'authenticated can still delete from bam_notifications';
  end if;
  if has_column_privilege('authenticated', 'bam_notifications', 'title', 'update') then
    raise exception 'authenticated can still rewrite bam_notifications.title';
  end if;
  if not has_column_privilege('authenticated', 'bam_notifications', 'read', 'update') then
    raise exception 'authenticated cannot mark bam_notifications read';
  end if;
  if not has_table_privilege('service_role', 'bam_notifications', 'insert') then
    raise exception 'service_role cannot insert into bam_notifications, so every notification would be dropped';
  end if;

  raise notice '0028: bam_notifications ready, 2 policies, update limited to read';
end $chk$;
