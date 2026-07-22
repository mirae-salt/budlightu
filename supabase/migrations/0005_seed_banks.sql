-- BLU Invoice · Canadian bank institution number lookup
-- Bank list sourced from Interac Sign-In partners (2026).
-- Mirrored in lib/banks.ts.
-- Numbers ARE seeds — program manager / finance to confirm before go-live.

insert into banks (name_normalized, institution_no, display_name) values
  ('affinity',          '839', 'Affinity Credit Union'),
  ('atb',               '219', 'ATB Financial'),
  ('bmo',               '001', 'BMO Bank of Montreal'),
  ('caisse alliance',   '815', 'Caisse Alliance'),
  ('cibc',              '010', 'CIBC'),
  ('coast capital',     '809', 'Coast Capital Savings'),
  ('conexus',           '839', 'Conexus Credit Union'),
  ('connectfirst',      '839', 'connectFirst Credit Union'),
  ('desjardins',        '815', 'Desjardins'),
  ('libro',             '839', 'Libro Credit Union'),
  ('meridian',          '839', 'Meridian Credit Union'),
  ('national',          '006', 'National Bank of Canada'),
  ('rbc',               '003', 'RBC Royal Bank'),
  ('scotiabank',        '002', 'Scotiabank'),
  ('scu',               '839', 'SCU (Steinbach Credit Union)'),
  ('servus',            '839', 'Servus Credit Union'),
  ('simplii',           '010', 'Simplii Financial'),
  ('tangerine',         '614', 'Tangerine'),
  ('td',                '004', 'TD Canada Trust'),
  ('uni',               '815', 'UNI Financial Cooperation'),
  ('vancity',           '809', 'Vancity'),
  ('wealthsimple',      '703', 'Wealthsimple')
on conflict (name_normalized) do update
  set institution_no = excluded.institution_no,
      display_name   = excluded.display_name;
