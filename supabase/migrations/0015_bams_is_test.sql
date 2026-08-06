-- Add is_test flag to bams table for distinguishing test accounts
alter table bams add column if not exists is_test boolean not null default false;
