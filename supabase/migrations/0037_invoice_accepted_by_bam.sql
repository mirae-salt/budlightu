-- A BAM can say "this is right" instead of being timed out into agreeing.
--
-- WHY
-- ---
-- The 24-hour window infers consent from silence, which is the weakest form of it and the
-- slowest: an invoice everybody is happy with still sits there until the clock runs out,
-- and after a correction the person who most wants it paid has no way to say so.
--
-- Mirae, 2026-09-16: "이 업뎃된거 확인받으려면 24시간 기다리는 방법 외에 없나?"
--
-- So: an explicit acceptance. It waives the WAIT and nothing else. An unanswered question
-- still holds the invoice, because that is Robin owing the student a reply rather than the
-- student owing us one, and the release is still required because you cannot accept what
-- you were never shown.
--
-- CLEARED BY A CORRECTION. `accepted_at` says "I checked THIS figure". The moment the
-- amount moves, that sentence is about a number that no longer exists, so both writers
-- that set `revised_at` clear this in the same update. Consent does not carry forward to
-- an amount nobody consented to.
alter table invoices add column if not exists accepted_at timestamptz;

comment on column invoices.accepted_at is
  'When the BAM confirmed the invoice is correct. Waives the 24-hour wait; an open '
  'question still blocks the send. Cleared whenever the amount changes, because it '
  'attests to the figure that was on screen when it was pressed.';
