-- Add Wealthsimple Cash to the bank lookup (0005 already applied to prior
-- environments, so this ships as its own row rather than editing 0005 in place).
-- Institution 703 / transit 00001 — sourced from Wealthsimple's own help centre
-- (help.wealthsimple.com), not yet cross-checked against Payments Canada's FIF.
insert into banks (name_normalized, institution_no, display_name) values
  ('wealthsimple', '703', 'Wealthsimple Cash')
on conflict (name_normalized) do update
  set institution_no = excluded.institution_no,
      display_name   = excluded.display_name;
