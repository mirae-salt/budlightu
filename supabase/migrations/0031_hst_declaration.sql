-- The ambassador's own statement about GST/HST registration.
--
-- Onboarding asked for an "HST number (optional)" and nothing else. Everyone left it
-- blank, so tax is $0 on every invoice today, but the reason on file was "nobody typed
-- anything" rather than "nobody is registered". Those are different facts to hold, and
-- only one of them is a statement the contractor made.
--
-- Mirrors the existing consent pattern (consent_terms_at / consent_terms_version): what
-- they said, when, and which wording they said it against.
--
-- hst_number itself is unchanged. It stays in the encrypted column written by
-- encrypt_bam_banking, and lib/invoice-payload still reads it the same way, so nothing
-- about how invoices are priced changes here.
--
-- Idempotent. Safe to re-apply.

alter table public.bams
  add column if not exists hst_status text
    check (hst_status in ('not_registered', 'registered')),
  add column if not exists hst_declared_at timestamptz,
  add column if not exists hst_declaration_version text;

comment on column public.bams.hst_status is
  'What the BAM declared at onboarding. NULL means they onboarded before the question existed, which is not the same as not_registered.';
comment on column public.bams.hst_declared_at is
  'When the declaration was made.';
comment on column public.bams.hst_declaration_version is
  'HST_DECLARATION_VERSION from lib/hst-declaration.ts, so an old row is never reinterpreted under new wording.';

-- Deliberately NOT backfilled to 'not_registered'.
--
-- The eleven rows that exist today onboarded before this question was asked. Writing a
-- declaration they never made would be inventing a record, and the whole point of the
-- column is that it holds something a person actually said. NULL reads as "never
-- asked", which is the truth.
