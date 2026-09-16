-- A corrected invoice stays on the BAM's screen and asks to be checked again.
--
-- WHAT 0035 DID, AND WHY IT WAS WRONG
-- -----------------------------------
-- 0035 cleared `released_at` whenever the amount changed after publishing. The intent was
-- right (an amount nobody reviewed must not go to AP on the strength of an old silence)
-- but the behaviour was wrong in two ways:
--
--   The BAM's row went back to "Being prepared" and the buttons vanished, with no reason
--   given. Somebody asked to check a figure, then watched it disappear.
--
--   Re-publishing needed an admin to notice and press release again. Nobody is told when
--   a background receipt decision revises an invoice, so the realistic outcome was Robin
--   discovering it at the AP send, and everyone waiting another day.
--
-- Mirae, 2026-09-16: "24시간동안 (수정 전) (수정완) 다시 체크 이렇게 계속 보여줘야해
-- release 부터 sent to AP 까지."
--
-- So a revision no longer un-publishes anything. `released_at` stays where it is, and
-- `revised_at` records that the figure moved afterwards. The objection window runs from
-- whichever is later, which restarts the 24 hours automatically, and both screens keep
-- showing the invoice the whole way from release to sent: published, then corrected and
-- asking to be looked at again.
--
-- The clock can only ever move FORWARD this way. A revision cannot shorten a window, and
-- because it restarts on every change, the last thing the BAM was shown is always the
-- thing they had 24 hours to object to.
alter table invoices add column if not exists revised_at timestamptz;

comment on column invoices.revised_at is
  'Set when the amount changed after the invoice was released to the BAM. The objection '
  'window runs from max(released_at, revised_at), so a correction restarts the 24 hours '
  'instead of un-publishing. Null means nothing has changed since release.';
