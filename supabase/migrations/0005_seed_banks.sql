-- BLU Invoice · Canadian bank institution number lookup
-- Reference: ARCHITECTURE.md §A.5 (17-row seed)
-- Normalization rule (mirrored in lib/banks.ts): lowercase, strip 'the ',
-- strip 'canada trust'/'bank'/'of canada', trim.
--
-- Numbers ARE seeds — Robin / finance to confirm before go-live.

insert into banks (name_normalized, institution_no, display_name) values
  ('rbc',                '003', 'RBC Royal Bank'),
  ('td',                 '004', 'TD Canada Trust'),
  ('bmo',                '001', 'BMO Bank of Montreal'),
  ('scotiabank',         '002', 'Scotiabank'),
  ('cibc',               '010', 'CIBC'),
  ('national',           '006', 'National Bank of Canada'),
  ('hsbc',               '016', 'HSBC Canada'),
  ('desjardins',         '815', 'Desjardins'),
  ('tangerine',          '614', 'Tangerine'),
  ('simplii',            '010', 'Simplii Financial'),
  ('eq',                 '623', 'EQ Bank'),
  ('equitable',          '623', 'Equitable Bank'),
  ('atb',                '219', 'ATB Financial'),
  ('laurentian',         '039', 'Laurentian Bank'),
  ('manulife',           '540', 'Manulife Bank'),
  ('canadian western',   '030', 'Canadian Western Bank'),
  ('coast capital',      '809', 'Coast Capital Savings'),
  ('vancity',            '809', 'Vancity')
on conflict (name_normalized) do update
  set institution_no = excluded.institution_no,
      display_name   = excluded.display_name;
