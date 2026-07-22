-- 0003 encrypts institution_no/transit_no/account_no in place (ciphertext,
-- base64-encoded pgp_sym_encrypt output). The shape CHECK constraints from
-- 0001 validate decrypted digit patterns and were flagged there as "drop once
-- encryption is stable" but never actually dropped — any encrypted write hits
-- them and fails. Plaintext shape is already HARD-FAIL validated before
-- encryption (lib/validation.ts, called from onboarding-ingest), so these
-- constraints are redundant on the now-ciphertext column and must go.
alter table bams drop constraint if exists bams_institution_shape;
alter table bams drop constraint if exists bams_transit_shape;
alter table bams drop constraint if exists bams_account_shape;
