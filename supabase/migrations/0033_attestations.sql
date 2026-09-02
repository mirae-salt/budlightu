-- Work authorization, banking ownership, and consent to automated-tool training data.
--
-- Shane Deen's 2026-08-27 worker-classification review, items B, E and F. Each is a
-- statement a contractor makes at setup; the columns are what makes it evidence rather
-- than a checkbox nobody kept.
--
-- Same shape as the GST/HST declaration in 0031 and the program terms before it: an
-- `_at` timestamp plus the wording version that was on screen, so a row always says
-- which text the person actually agreed to.
--
-- NOT BACKFILLED, on purpose. A NULL here means "never asked", which is the truth for
-- everyone who onboarded before today. Writing a date nobody agreed on would turn an
-- empty column into a false record, which is worse than an empty column. Three real
-- students are in that position; the other 57 are still pending and will be asked.

alter table bams
  -- Required at setup. Present means ticked, since the API refuses the submission
  -- otherwise, so there is no "attested = false" state to store.
  add column if not exists work_auth_attested_at       timestamptz,
  add column if not exists work_auth_version           text,
  add column if not exists banking_attested_at         timestamptz,
  add column if not exists banking_version             text,

  -- Optional, and refusable, which is the whole point of asking it separately from the
  -- program terms (Shane: bundling it in "won't meet the meaningful-consent standard").
  -- Three states: true agreed, false declined, NULL never asked. A nullable boolean is
  -- carrying real information here, not laziness.
  add column if not exists consent_ai_training         boolean,
  add column if not exists consent_ai_training_at      timestamptz,
  add column if not exists consent_ai_training_version text;

comment on column bams.work_auth_attested_at is
  'When the BAM confirmed they may do self-employed contractor work in Canada. NULL means never asked.';
comment on column bams.banking_attested_at is
  'When the BAM confirmed the bank account is in their own name. NULL means never asked.';
comment on column bams.consent_ai_training is
  'Optional consent to use support messages as training data. true agreed, false declined, NULL never asked. Refusing changes nothing about pay.';
