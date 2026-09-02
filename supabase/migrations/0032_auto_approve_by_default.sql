-- Auto-approve is the default for every cohort created from now on.
--
-- `cohorts.first_cohort_all_review` was created with `default true` in 0001, back
-- when review-everything was the plan for a new program. It is not the plan any
-- more (Mirae, stated repeatedly since 2026-08-10, and it is what lib/policy.ts
-- has said since): the program exists to remove ~5 hours a month of manual
-- checking, and 58 BAMs x 8 months = 464 receipts each needing a click is the
-- problem rather than the safeguard.
--
-- The column default outlived the decision, so every cohort created through the
-- admin UI silently came back with review-everything ON while lib/policy.ts's
-- default said OFF. The two disagreed and the column won, because
-- api/receipts/ocr reads the cohort row.
--
-- Turning this off does NOT turn off review. classify-receipt still sends a
-- receipt to Robin when no Bud Light line is found, OCR confidence is low, the
-- total sits at or near the cap, a duplicate is detected, or the server cannot
-- corroborate the amount. What changes is that a clean receipt stops waiting for
-- a click it never needed.
--
-- A cohort can still be put back into review-everything deliberately by setting
-- the column to true on that row; only the default moves here.

alter table cohorts alter column first_cohort_all_review set default false;

-- rollover_mode already defaults to 'forfeit' (0001), which matches Robin's
-- 2026-08-04 decision: flat $150 a month, no carryover. No change needed to the
-- default. Existing rows that were set to 'accumulate' under the superseded
-- 2026-07-15 model are corrected by scripts/probe/fix-cohort-money-rules.js,
-- not here, so that the change is recorded with a before/after read-back rather
-- than applied silently by a deploy.

comment on column cohorts.first_cohort_all_review is
  'When true, EVERY receipt in this cohort goes to admin review regardless of what the '
  'classifier found. Defaults to false since 0032. The name says "first 3 months" but the '
  'code applies no date window (lib/classify-receipt.ts): it stays on until someone turns it off.';
