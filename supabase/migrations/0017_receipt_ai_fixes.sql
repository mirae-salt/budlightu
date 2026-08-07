-- ============================================================================
-- 0017 · receipt-AI audit fixes (AUDIT-2026-08-07)
--
--   P1-13  receipts.ocr_queued_at / ocr_started_at + sweep_stale_ocr_receipts()
--          so a receipt whose OCR trigger was dropped can never stay invisible.
--   P1-3   real scheduler mutex (scheduler_locks + acquire/release) replacing the
--          no-op pg_try_advisory_xact_lock helper, which released at the end of
--          the PostgREST RPC transaction, i.e. before any work started.
--
-- Existing objects are left in place: try_scheduler_lock() is still referenced by
-- supabase/functions/scheduler-generate (owned by another workstream) and must
-- keep working until that caller is migrated.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- P1-13 · OCR queue bookkeeping on receipts
-- ----------------------------------------------------------------------------
alter table receipts add column if not exists ocr_queued_at  timestamptz;
alter table receipts add column if not exists ocr_started_at timestamptz;

comment on column receipts.ocr_queued_at is
  'Set when the OCR call is scheduled. A row still status=pending with an old '
  'ocr_queued_at means the trigger was dropped (Vercel froze the invocation) — '
  'sweep_stale_ocr_receipts() makes it visible to admins.';
comment on column receipts.ocr_started_at is
  'Set by /api/receipts/ocr when it begins work. Diagnostic only: the sweep keys '
  'off status + ocr_queued_at so a started-but-abandoned run is also caught.';

-- Backfill so pre-existing pending rows are sweepable rather than invisible.
update receipts set ocr_queued_at = uploaded_at where ocr_queued_at is null;

create index if not exists receipts_pending_ocr_idx
  on receipts (ocr_queued_at)
  where status = 'pending';

-- ----------------------------------------------------------------------------
-- P1-13 · sweeper: pending past the cutoff becomes ocr_failed (visible in the
-- admin review queue, which selects status in ('review','ocr_failed')).
-- ocr_failed is excluded from shortfall math, so this never invents a shortfall.
-- ----------------------------------------------------------------------------
create or replace function sweep_stale_ocr_receipts(p_stale_minutes int default 15)
returns table (
  receipt_id   uuid,
  out_bam_id   uuid,
  out_period   date,
  out_queued_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz := now() - make_interval(mins => p_stale_minutes);
begin
  return query
  with upd as (
    update receipts r
       set status = 'ocr_failed',
           decision_reason = 'ocr_not_started: still pending ' || p_stale_minutes
                             || ' minutes after being queued; OCR never completed. Use Retry OCR.'
     where r.status = 'pending'
       and coalesce(r.ocr_queued_at, r.uploaded_at) < v_cutoff
    returning r.id, r.bam_id, r.period, coalesce(r.ocr_queued_at, r.uploaded_at) as queued_at
  )
  select upd.id, upd.bam_id, upd.period, upd.queued_at from upd;
end $$;

comment on function sweep_stale_ocr_receipts is
  'P1-13 backstop. Flips receipts stranded at status=pending to ocr_failed so they '
  'surface in the admin review queue. Returns the rows it changed — callers must '
  'report a non-empty result, never swallow it.';

revoke all on function sweep_stale_ocr_receipts(int) from public;

-- ----------------------------------------------------------------------------
-- P1-3 · real scheduler mutex
--
-- pg_try_advisory_xact_lock is TRANSACTION scoped. Each PostgREST RPC commits
-- immediately, so the old try_scheduler_lock() released the lock before the
-- caller did any work and two concurrent runs both proceeded. This replaces it
-- with a lock ROW that survives the RPC, with a TTL so a crashed run cannot
-- wedge the job forever.
-- ----------------------------------------------------------------------------
create table if not exists scheduler_locks (
  job_name    text primary key,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  holder      text,
  released_at timestamptz
);

alter table scheduler_locks enable row level security;
-- no policies on purpose: service_role only (it bypasses RLS)

create or replace function acquire_scheduler_lock(
  p_job_name    text,
  p_ttl_seconds int  default 900,
  p_holder      text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now  timestamptz := now();
  v_rows int;
begin
  insert into scheduler_locks as l (job_name, acquired_at, expires_at, holder, released_at)
  values (p_job_name, v_now, v_now + make_interval(secs => p_ttl_seconds), p_holder, null)
  on conflict (job_name) do update
     set acquired_at = v_now,
         expires_at  = v_now + make_interval(secs => p_ttl_seconds),
         holder      = excluded.holder,
         released_at = null
   where l.released_at is not null
      or l.expires_at < v_now;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

comment on function acquire_scheduler_lock is
  'Returns true only if this call took the lock. The lock row outlives the RPC '
  'transaction (unlike pg_try_advisory_xact_lock) and auto-expires after '
  'p_ttl_seconds so a crashed run cannot wedge the job. Callers MUST treat an '
  'RPC error as "did not acquire" (fail closed) and MUST release when done.';

create or replace function release_scheduler_lock(p_job_name text) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_rows int;
begin
  update scheduler_locks
     set released_at = now()
   where job_name = p_job_name
     and released_at is null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

revoke all on function acquire_scheduler_lock(text, int, text) from public;
revoke all on function release_scheduler_lock(text) from public;

comment on function try_scheduler_lock(text) is
  'DEPRECATED (P1-3): pg_try_advisory_xact_lock is transaction scoped and the '
  'PostgREST RPC commits immediately, so this is a no-op mutex. Use '
  'acquire_scheduler_lock()/release_scheduler_lock() instead. Kept only until '
  'scheduler-generate is migrated.';
