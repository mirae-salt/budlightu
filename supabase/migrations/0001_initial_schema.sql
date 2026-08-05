-- BLU Invoice · initial schema
-- Reference: ARCHITECTURE.md §B.0
-- All money-adjacent fields (institution/transit/account) stored as TEXT to preserve leading zeros.

create extension if not exists "pgcrypto";

-- ============================================================================
-- cohorts
-- ============================================================================
create table cohorts (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  program_label               text not null,                 -- e.g. "BL Campus", "BL Summer BAMs"
  po_number                   text,                          -- must be set before first send
  salary_default              numeric(10,2) not null,        -- 218.75 school year / 250 summer
  reimbursement_max           numeric(10,2) not null default 150,
  rollover_mode               text not null default 'forfeit'
                              check (rollover_mode in ('accumulate','forfeit')),
  cap_multiplier              int not null default 1,
  send_mode                   text not null default 'dryrun'
                              check (send_mode in ('dryrun','live')),
  bam_copy_mode               text not null default 'draft'
                              check (bam_copy_mode in ('off','draft','live')),
  first_cohort_all_review     boolean not null default true,
  currency                    text not null default 'CAD' check (currency = 'CAD'),
  start_date                  date not null,
  end_date                    date not null,
  months                      int generated always as
                              ((extract(year from end_date) - extract(year from start_date))*12
                               + (extract(month from end_date) - extract(month from start_date))) stored,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- ============================================================================
-- bams — pending (from roster) → active (after onboarding) → archived
-- ============================================================================
create table bams (
  id                          uuid primary key default gen_random_uuid(),
  cohort_id                   uuid not null references cohorts(id),

  first_name                  text not null,
  last_name                   text not null,
  email                       text not null,
  phone                       text,

  street                      text,
  city                        text,
  prov                        text,
  postal                      text,
  school_id                   text,                          -- flat string in v1

  bank_name                   text,

  -- banking fields — TEXT (leading zeros); encrypted at rest via pgsodium (see 0003)
  institution_no              text,
  transit_no                  text,
  account_no                  text,
  hst_number                  text,

  consent_ap_cc               boolean,

  status                      text not null default 'pending'
                              check (status in ('pending','active','archived')),

  auth_user_id                uuid,                          -- Supabase auth.users.id, set on activation
  initials_resolved           text,                          -- e.g. "LG", "LGR", "LUGR"
  email_verified_at           timestamptz,                   -- set on first successful login
  invite_token_hash           text,                          -- sha256 of one-time onboarding token

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  -- P0-1 constraint: initials must be unique within cohort
  constraint bams_initials_unique unique (cohort_id, initials_resolved),

  -- digit checks (revalidated across pipeline; also enforced in code)
  constraint bams_institution_shape check (institution_no is null or institution_no ~ '^\d{3}$'),
  constraint bams_transit_shape     check (transit_no     is null or transit_no     ~ '^\d{5}$'),
  constraint bams_account_shape     check (account_no     is null or account_no     ~ '^\d{6,12}$')
);

create index bams_cohort_status_idx on bams(cohort_id, status);
create unique index bams_auth_user_id_uniq on bams(auth_user_id) where auth_user_id is not null;
create unique index bams_email_lower_uniq on bams(lower(email));

-- ============================================================================
-- onboarding_submissions — parked form data awaiting match
-- ============================================================================
create table onboarding_submissions (
  id                          uuid primary key default gen_random_uuid(),
  submitted_email             text not null,
  form_json_meta              jsonb not null default '{}',   -- non-sensitive metadata only
  -- sensitive fields deliberately not stored here; they go to bams (encrypted) on match
  -- or are dropped if unmatched after retention period
  matched_bam_id              uuid references bams(id),
  status                      text not null default 'unmatched'
                              check (status in ('matched','unmatched','resolved','rejected')),
  flag_reason                 text,
  submitted_at                timestamptz not null default now(),
  resolved_at                 timestamptz,
  purge_at                    timestamptz not null default (now() + interval '30 days')
);
create index onboarding_submissions_status_idx on onboarding_submissions(status, purge_at);

-- ============================================================================
-- receipts
-- ============================================================================
create table receipts (
  id                          uuid primary key default gen_random_uuid(),
  bam_id                      uuid not null references bams(id),
  cohort_id                   uuid not null references cohorts(id),
  period                      date not null,                 -- first of month

  storage_key                 text not null,                 -- supabase storage path
  storage_mime                text not null,
  storage_bytes               int not null,
  sha256                      text not null,

  ocr_json                    jsonb,
  ocr_attempts                int not null default 0,

  status                      text not null default 'pending'
                              check (status in ('pending','auto_pass','review','approved','rejected','ocr_failed')),

  decided_by                  uuid,                          -- admin user id or 'system'
  decided_at                  timestamptz,
  decision_reason             text,

  bud_light_total_incl_tax    numeric(10,2),
  confidence                  numeric(3,2),
  ambiguous_flags             jsonb,

  uploaded_at                 timestamptz not null default now(),

  constraint receipts_confidence_range check (confidence is null or (confidence >= 0 and confidence <= 1))
);
create index receipts_bam_period_idx on receipts(bam_id, period);
create index receipts_cohort_status_idx on receipts(cohort_id, status);
create unique index receipts_sha256_bam_uniq on receipts(bam_id, sha256);  -- prevent same-BAM re-upload double-count

-- ============================================================================
-- reimbursement_ledger — monthly rollup per BAM (source of truth for what's paid)
-- ============================================================================
create table reimbursement_ledger (
  id                          uuid primary key default gen_random_uuid(),
  bam_id                      uuid not null references bams(id),
  cohort_id                   uuid not null references cohorts(id),
  period                      date not null,

  entitlement_usd             numeric(10,2) not null,
  spent_usd                   numeric(10,2) not null default 0,
  carryover_in_usd            numeric(10,2) not null default 0,
  carryover_out_usd           numeric(10,2) not null default 0,
  paid_usd                    numeric(10,2) not null default 0,
  spendable_cap_usd           numeric(10,2) not null,
  cap_snapshot_usd            numeric(10,2) not null,
  shortfall_flag              boolean not null default false,
  policy_version              int not null default 1,
  currency                    text not null default 'CAD' check (currency = 'CAD'),

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  text                                        -- 'system' or admin id

  ,constraint ledger_unique_period unique (bam_id, cohort_id, period)
);
create index ledger_shortfall_idx on reimbursement_ledger(cohort_id, period, shortfall_flag);

-- ============================================================================
-- invoices — data → render (payload stored, PDF regenerated on send)
-- ============================================================================
create table invoices (
  id                          uuid primary key default gen_random_uuid(),
  bam_id                      uuid not null references bams(id),
  cohort_id                   uuid not null references cohorts(id),
  period                      date not null,

  seq                         int not null,                   -- per-BAM sequence
  invoice_number              text not null,                  -- "INV-LGR3" etc.

  payload_json                jsonb not null,                 -- resolved 19-token snapshot
  pdf_key                     text,                           -- storage key if pre-rendered

  status                      text not null default 'draft'
                              check (status in ('draft','sent','paid','void')),
  void_reason                 text,
  superseded_by               uuid references invoices(id),

  currency                    text not null default 'CAD' check (currency = 'CAD'),

  created_at                  timestamptz not null default now(),
  sent_at                     timestamptz
);
-- P0-1: enforce per-BAM seq uniqueness (excluding void) + invoice number string uniqueness within cohort
create unique index invoices_bam_seq_uniq on invoices(bam_id, seq) where status <> 'void';
create unique index invoices_bam_period_uniq on invoices(bam_id, cohort_id, period) where status <> 'void';
create unique index invoices_number_uniq on invoices(cohort_id, invoice_number) where status <> 'void';

-- ============================================================================
-- invoice_sends — one row per (invoice × target × mode), P0-5a enforcement
-- ============================================================================
create table invoice_sends (
  id                          uuid primary key default gen_random_uuid(),
  invoice_id                  uuid not null references invoices(id),
  target                      text not null check (target in ('ap','bam','sharepoint')),
  mode                        text not null check (mode in ('dryrun','live','draft','off')),
  address                     text,                           -- email / sharepoint path
  message_id                  text,
  attempts                    int not null default 0,
  last_error                  text,
  sent_at                     timestamptz,

  constraint invoice_sends_unique unique (invoice_id, target, mode)  -- P0-5a
);

-- ============================================================================
-- ap_cancellations — P0-5b: void of sent invoice generates AP cancellation draft
-- ============================================================================
create table ap_cancellations (
  id                          uuid primary key default gen_random_uuid(),
  original_invoice_id         uuid not null references invoices(id),
  superseded_by               uuid references invoices(id),
  reason                      text not null,
  draft_key                   text,                           -- storage of draft email body
  sent_at                     timestamptz,
  sent_by                     uuid,
  created_at                  timestamptz not null default now()
);

-- ============================================================================
-- banks — normalized lookup (leading-zero preserving)
-- ============================================================================
create table banks (
  name_normalized             text primary key,
  institution_no              text not null check (institution_no ~ '^\d{3}$'),
  display_name                text not null
);

-- ============================================================================
-- policy — key/value config (rollover_mode default, thresholds, etc.)
-- ============================================================================
create table policy (
  key                         text primary key,
  value_json                  jsonb not null,
  version                     int not null default 1,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid
);

-- ============================================================================
-- portal_questions — v1 = email-only alert, no queue UI yet
-- ============================================================================
create table portal_questions (
  id                          uuid primary key default gen_random_uuid(),
  bam_id                      uuid references bams(id),
  cohort_id                   uuid references cohorts(id),
  question                    text not null,
  submitted_at                timestamptz not null default now(),
  notified_at                 timestamptz
);

-- ============================================================================
-- audit_log — every write action by admin (and system writes to sensitive tables)
-- ============================================================================
create table audit_log (
  id                          uuid primary key default gen_random_uuid(),
  actor_id                    uuid,
  actor_role                  text,                            -- 'super_admin' | 'program_admin' | 'system' | 'bam'
  entity                      text not null,                   -- table name
  entity_id                   uuid,
  action                      text not null,                   -- insert/update/delete/decision/send/...
  before_json                 jsonb,
  after_json                  jsonb,
  ts                          timestamptz not null default now()
);
create index audit_log_entity_idx on audit_log(entity, entity_id, ts desc);

-- ============================================================================
-- updated_at triggers
-- ============================================================================
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger cohorts_updated_at before update on cohorts for each row execute function set_updated_at();
create trigger bams_updated_at    before update on bams    for each row execute function set_updated_at();
create trigger ledger_updated_at  before update on reimbursement_ledger for each row execute function set_updated_at();
