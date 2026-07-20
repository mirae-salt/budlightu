-- BLU Invoice · RLS policies
-- Roles established via a `role` claim on the Supabase JWT (set at auth trigger time).
-- Values: 'bam' (default for magic-link students), 'program_admin', 'super_admin'.

-- Helper: current role
create or replace function current_role_claim() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(current_setting('request.jwt.claim.role', true), 'bam')
$$;

create or replace function current_bam_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from bams where auth_user_id = auth.uid() limit 1
$$;

create or replace function current_admin_cohorts() returns setof uuid
language sql stable security definer set search_path = public as $$
  -- v1: program_admin sees all active cohorts; super_admin sees all
  -- (per-cohort admin scoping can be added later via admin_cohort_membership table)
  select id from cohorts
$$;

-- ============================================================================
-- Enable RLS on all sensitive tables
-- ============================================================================
alter table cohorts                  enable row level security;
alter table bams                     enable row level security;
alter table onboarding_submissions   enable row level security;
alter table receipts                 enable row level security;
alter table reimbursement_ledger     enable row level security;
alter table invoices                 enable row level security;
alter table invoice_sends            enable row level security;
alter table ap_cancellations         enable row level security;
alter table banks                    enable row level security;
alter table policy                   enable row level security;
alter table portal_questions         enable row level security;
alter table audit_log                enable row level security;

-- ============================================================================
-- cohorts — admins read/write; BAM reads own cohort
-- ============================================================================
create policy cohorts_admin_all on cohorts
  for all using (current_role_claim() in ('program_admin','super_admin'))
  with check (current_role_claim() in ('program_admin','super_admin'));

create policy cohorts_bam_read_own on cohorts for select
  using (id in (select cohort_id from bams where auth_user_id = auth.uid()));

-- ============================================================================
-- bams — student sees own row; admins see cohort
-- ============================================================================
create policy bams_admin_all on bams
  for all using (current_role_claim() in ('program_admin','super_admin'))
  with check (current_role_claim() in ('program_admin','super_admin'));

create policy bams_self_read on bams for select
  using (auth_user_id = auth.uid());

-- students CANNOT update their own banking (only through onboarding flow via service role)
-- explicitly no update/insert policy for BAM role beyond read

-- ============================================================================
-- onboarding_submissions — SUPER ADMIN ONLY (P0-3)
-- ============================================================================
create policy onboarding_super_admin_only on onboarding_submissions
  for all using (current_role_claim() = 'super_admin')
  with check (current_role_claim() = 'super_admin');

-- Program admins get a view (created in 0004) that exposes only summary fields.

-- ============================================================================
-- receipts — student read/insert own; admins read/write cohort
-- ============================================================================
create policy receipts_admin_all on receipts
  for all using (current_role_claim() in ('program_admin','super_admin'))
  with check (current_role_claim() in ('program_admin','super_admin'));

create policy receipts_self_read on receipts for select
  using (bam_id = current_bam_id());

create policy receipts_self_insert on receipts for insert
  with check (bam_id = current_bam_id() and status = 'pending');

-- students cannot update/delete their own receipts (only cancel via admin action)

-- ============================================================================
-- reimbursement_ledger — read-only for students; admins read/write
-- ============================================================================
create policy ledger_admin_all on reimbursement_ledger
  for all using (current_role_claim() in ('program_admin','super_admin'))
  with check (current_role_claim() in ('program_admin','super_admin'));

create policy ledger_self_read on reimbursement_ledger for select
  using (bam_id = current_bam_id());

-- ============================================================================
-- invoices — student sees own; admins full
-- ============================================================================
create policy invoices_admin_all on invoices
  for all using (current_role_claim() in ('program_admin','super_admin'))
  with check (current_role_claim() in ('program_admin','super_admin'));

create policy invoices_self_read on invoices for select
  using (bam_id = current_bam_id());

-- ============================================================================
-- invoice_sends, ap_cancellations, audit_log — admin only
-- ============================================================================
create policy invoice_sends_admin_all on invoice_sends
  for all using (current_role_claim() in ('program_admin','super_admin'))
  with check (current_role_claim() in ('program_admin','super_admin'));

create policy ap_cancellations_admin_all on ap_cancellations
  for all using (current_role_claim() in ('program_admin','super_admin'))
  with check (current_role_claim() in ('program_admin','super_admin'));

create policy audit_log_super_admin_read on audit_log for select
  using (current_role_claim() = 'super_admin');

-- audit_log inserts happen only through service role (triggers/edge functions); no direct policy

-- ============================================================================
-- banks — admins read/write; students read (dropdown)
-- ============================================================================
create policy banks_read_all on banks for select using (true);
create policy banks_admin_write on banks
  for insert with check (current_role_claim() in ('program_admin','super_admin'));
create policy banks_admin_update on banks
  for update using (current_role_claim() in ('program_admin','super_admin'))
             with check (current_role_claim() in ('program_admin','super_admin'));

-- ============================================================================
-- policy — super admin only for writes; read for admins
-- ============================================================================
create policy policy_admin_read on policy for select
  using (current_role_claim() in ('program_admin','super_admin'));
create policy policy_super_admin_write on policy
  for insert with check (current_role_claim() = 'super_admin');
create policy policy_super_admin_update on policy
  for update using (current_role_claim() = 'super_admin')
             with check (current_role_claim() = 'super_admin');

-- ============================================================================
-- portal_questions — students insert own; admins read
-- ============================================================================
create policy portal_questions_self_insert on portal_questions for insert
  with check (bam_id = current_bam_id());
create policy portal_questions_admin_read on portal_questions for select
  using (current_role_claim() in ('program_admin','super_admin'));

-- ============================================================================
-- Program-admin summary view for onboarding_submissions (no sensitive fields)
-- ============================================================================
create or replace view onboarding_submissions_summary as
select id, submitted_email, matched_bam_id, status, flag_reason,
       submitted_at, resolved_at, purge_at
from onboarding_submissions;

-- Grant to authenticated role — RLS on underlying still applies for direct access.
grant select on onboarding_submissions_summary to authenticated;
