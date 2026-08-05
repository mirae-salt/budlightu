-- BAM low-spend warnings
-- Robin gets notified when a BAM underspends. She sends a warning.
-- After 2 warnings → reevaluate standing in the program.

create table bam_warnings (
  id              uuid primary key default gen_random_uuid(),
  bam_id          uuid not null references bams(id),
  cohort_id       uuid not null references cohorts(id),
  period          text not null,                               -- "2026-09" month of shortfall
  spent           numeric(10,2) not null,                      -- actual amount spent that month
  cap             numeric(10,2) not null default 150,          -- cap for reference
  warning_number  int not null,                                -- 1, 2, 3... (per BAM per cohort)
  sent_at         timestamptz,                                 -- null until email actually sent
  sent_by         text,                                        -- admin email who triggered send
  notes           text,                                        -- optional admin notes
  created_at      timestamptz not null default now(),

  constraint bam_warnings_unique unique (bam_id, cohort_id, period)
);

create index idx_bam_warnings_bam on bam_warnings(bam_id);
create index idx_bam_warnings_cohort on bam_warnings(cohort_id);

-- RLS: only service role and authenticated admins
alter table bam_warnings enable row level security;

create policy "service_role full access on bam_warnings"
  on bam_warnings for all
  using (auth.role() = 'service_role');
