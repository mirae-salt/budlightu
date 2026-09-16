-- Two changes decided on 2026-09-16, in one migration because both land the same day.
--
-- 1. A BAM sees their invoice and gets 24 hours to object BEFORE it goes to AP.
-- 2. A BAM can submit a receipt for a special or limited release bought outside the
--    normal window, and that submission is always reviewed by a person.
--
-- WHY (1): A LEGAL REQUIREMENT, NOT A UX IMPROVEMENT
-- --------------------------------------------------
-- Until now the first time a BAM could see what was billed on their behalf was the copy
-- that went out with the AP email, which is after the money is already moving. Legal
-- wants an interval where the person being paid can say "that is wrong" and be heard
-- before the payment leaves. Silence during that interval counts as acceptance, so the
-- interval has to be recorded, not assumed: `released_at` is the moment we can prove the
-- final figure was put in front of them.
--
-- The window opens on an explicit human action, not on a date. The cadence already
-- splits the 16th (audit, Robin clears flagged receipts) from the 17th (generate) so
-- that Robin has a day to review, and moving generate earlier to hit a fixed publish
-- time would take that day back. An admin pressing "release" says "this number is
-- final" at a moment they choose, which is also the assertion Legal actually wants.
--
-- WHY (2): THE PURCHASE DATE CANNOT BE THE GATE
-- ---------------------------------------------
-- The obvious build is "accept a receipt whose purchase date is within three months and
-- flag it". Measured against production on 2026-09-16, that would not work: of 109 real
-- receipts, only 70 carry a purchase date inside their own period window. 17 carry a
-- year that is not 2026 at all (thermal receipts print `09/12/26` and the model reads
-- the year off the wrong field), and 15 have no date the model could read. A quarter of
-- ordinary receipts would land in the review queue on the strength of a field that is
-- wrong a quarter of the time, and a queue that is mostly noise is a queue nobody reads.
--
-- So the student declares it instead. `late_submission` is their claim that this was a
-- special or limited release bought outside the normal window. The claim alone forces
-- review; whether the date on the paper actually supports it is Robin's call with the
-- image in front of her. Nothing here trusts the OCR date.
--
-- WHICH MONTH'S $150 IT SPENDS: the month it was SUBMITTED in (Mirae, 2026-09-16),
-- because that is the cap the BAM still has room in. That decision is why this migration
-- adds no period columns: a late receipt is filed against the open period like any
-- other, so it can never reach back into a month whose invoice has already gone to AP.

-- ── 1. Invoice release + dispute ──────────────────────────────────────────────

alter table invoices add column if not exists released_at timestamptz;
alter table invoices add column if not exists released_by uuid;

comment on column invoices.released_at is
  'When this invoice was published to the BAM, starting their 24-hour objection window. '
  'Null means they have not been shown the final figure, and send-ap refuses to send.';

-- AN OBJECTION IS A QUESTION THREAD, NOT A NEW KIND OF RECORD
-- -----------------------------------------------------------
-- This started as its own `invoice_disputes` table with a reason, a resolution and a
-- resolved_at. That was a second, worse copy of something this schema already has:
-- `portal_questions` threads a conversation, notifies the admin when one opens, notifies
-- the BAM when it is answered, and mirrors the whole thread to email (0027, and the
-- 2026-08-13 ruling that threads live in the portal). A separate table would have meant
-- two inboxes for Robin, one of which nobody would have wired an email into.
--
-- So an objection is a portal question that points at an invoice. Everything a thread
-- already does, it keeps doing. The only new fact is which invoice it is about.
--
-- UNANSWERED IS THE SAME AS UNRESOLVED. `answered_at is null` already means "a person
-- still owes this student a reply", which is exactly the condition that has to hold the
-- payment, so the send gate needs no state of its own.
alter table portal_questions add column if not exists invoice_id uuid references invoices(id) on delete set null;

comment on column portal_questions.invoice_id is
  'Set when the thread was opened from an invoice the BAM thinks is wrong. While such a '
  'thread is unanswered, batch-approve refuses to send that invoice to AP.';

-- The send gate asks exactly this: is there an unanswered thread about this invoice.
create index if not exists portal_questions_open_invoice_idx
  on portal_questions (invoice_id) where answered_at is null and invoice_id is not null;

-- ── 2. Late / special-release receipt submissions ─────────────────────────────

alter table receipts add column if not exists late_submission boolean not null default false;

comment on column receipts.late_submission is
  'The BAM declared this a special or limited release bought outside the normal window. '
  'Forces review in lib/classify-receipt: it can never auto-pass. Not derived from the '
  'OCR date, which is wrong on about a quarter of real receipts.';
