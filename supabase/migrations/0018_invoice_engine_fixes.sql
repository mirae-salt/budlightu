-- 0018_invoice_engine_fixes.sql
-- Schema side of the invoice-engine fixes from .claude/AUDIT-2026-08-07.md.
-- Covers P0-B, P0-C, P1-2 and P1-22. Nothing here changes an amount; it only
-- adds the columns/indexes the code needs to be idempotent and retryable.

-- ============================================================================
-- P0-B / P0-C · invoice_sends: tell a completed send apart from a failed attempt
-- ============================================================================
-- Before: failures were written as mode:'dryrun' rows and the guard read any row
-- as "already sent", so one failed send blocked every retry forever (BAM never
-- paid) while a genuine duplicate was still possible because there was no
-- pre-send check at all.
--
-- After: `sent_at is not null` is the ONLY thing that blocks a resend, and the
-- partial unique index below makes a second completed send per (invoice,target)
-- structurally impossible — across modes, not just within one mode.
--   sending -> claim taken before the external call
--   sent    -> external call succeeded (sent_at set)
--   drafted -> dryrun/draft only, nothing left the building (sent_at NULL)
--   failed  -> retryable (sent_at NULL)

alter table invoice_sends add column if not exists status text not null default 'sent';
alter table invoice_sends add column if not exists started_at timestamptz;

-- Backfill legacy rows honestly: rows without sent_at were failed attempts.
update invoice_sends
   set status = case when sent_at is not null then 'sent' else 'failed' end
 where status is null or status not in ('sending','sent','drafted','failed');

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_sends_status_check') then
    alter table invoice_sends
      add constraint invoice_sends_status_check
      check (status in ('sending','sent','drafted','failed'));
  end if;
end $$;

-- Structural duplicate protection. If this index fails to create, there are
-- already two completed sends for one (invoice,target) in the data — that means
-- AP received the same invoice twice and it must be investigated, not bypassed.
create unique index if not exists invoice_sends_one_success
  on invoice_sends(invoice_id, target) where sent_at is not null;

comment on column invoice_sends.status is
  'sending = claim taken before the external call; sent = it succeeded (sent_at set); drafted = dryrun/draft only; failed = retryable. Only sent_at blocks a resend.';
comment on column invoice_sends.started_at is
  'When the claim was taken. A claim older than ~10 min is treated as stale so a crashed run cannot block payment permanently.';

-- ============================================================================
-- P1-2 · invoices: the 'approved' status and approved_at that batch-approve used
-- ============================================================================
-- batch-approve wrote status:'approved' and approved_at, neither of which
-- existed: the CHECK only allowed ('draft','sent','paid','void') and approved_at
-- was in no migration, so touchpoint 2 always returned 500.

alter table invoices drop constraint if exists invoices_status_check;
alter table invoices add constraint invoices_status_check
  check (status in ('draft','approved','sent','paid','void'));

alter table invoices add column if not exists approved_at timestamptz;
alter table invoices add column if not exists approved_by uuid;

comment on column invoices.approved_at is
  'Set by batch-approve AFTER that invoice''s AP send succeeded. Never set ahead of the send.';

-- ============================================================================
-- P1-22 · invoice numbers can never be reused after a void
-- ============================================================================
-- invoices_number_uniq is partial (where status <> 'void'), so voiding INV-LG3
-- and regenerating produced a second INV-LG3 with a different amount — two
-- different documents under one number as far as AP is concerned.
--
-- Reissues now keep their seq and bump `revision`, which the code renders as
-- "INV-LG3-R2". The index below then holds for every status.
-- ⚠️ AP-FACING FORMAT: the "-R2" suffix needs Robin/AP confirmation. Revision 1
-- is unchanged, so nothing differs until an invoice is voided and reissued.

alter table invoices add column if not exists revision int not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_revision_positive') then
    alter table invoices
      add constraint invoices_revision_positive check (revision >= 1);
  end if;
end $$;

-- Same note as above: a failure here means duplicate numbers already exist in
-- the data and a human has to reconcile them with AP.
create unique index if not exists invoices_number_all_uniq
  on invoices(cohort_id, invoice_number);

comment on column invoices.revision is
  'P1-22: 1 normally; incremented when a voided invoice for the same period is reissued, rendering as INV-<initials><seq>-R<revision>.';
