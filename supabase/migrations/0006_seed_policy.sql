-- BLU Invoice · default policy values
-- These are defaults; per-cohort overrides live in the `cohorts` table.

insert into policy (key, value_json) values
  ('reimbursement_max_default',            '150'::jsonb),
  ('salary_school_year_default',           '218.75'::jsonb),
  ('salary_summer_default',                '250'::jsonb),
  ('rollover_mode_default',                '"accumulate"'::jsonb),
  ('cap_multiplier_default',               '1'::jsonb),
  ('consecutive_shortfall_warn_at',        '3'::jsonb),
  ('first_cohort_all_review_default',      'true'::jsonb),

  -- OCR / audit
  ('auto_pass_min_overall_confidence',     '0.85'::jsonb),
  ('auto_pass_min_line_confidence',        '0.80'::jsonb),
  ('review_band_padding_usd',              '10'::jsonb),
  ('ocr_max_retry_attempts',               '3'::jsonb),

  -- send guardrails
  ('send_mode_default',                    '"dryrun"'::jsonb),
  ('bam_copy_mode_default',                '"draft"'::jsonb),

  -- rate limits (per IP per day)
  ('onboarding_attempts_per_ip_per_day',   '3'::jsonb),
  ('onboarding_attempts_per_token',        '3'::jsonb),
  ('receipt_uploads_per_bam_per_day',      '20'::jsonb),

  -- retention (days)
  ('onboarding_soft_delete_days',          '30'::jsonb),
  ('onboarding_hard_purge_days',           '60'::jsonb),

  -- PO default (⚠️ awaiting Robin confirmation — 250437 / 260814 / 260351)
  ('default_po_number',                    '"250437"'::jsonb)

on conflict (key) do update set value_json = excluded.value_json, updated_at = now();
