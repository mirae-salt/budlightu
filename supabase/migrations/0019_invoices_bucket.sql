-- 0019_invoices_bucket.sql
-- WRITTEN, NOT APPLIED.
--
-- F1 (critic gate 2026-08-07): three senders required `invoices.pdf_key` and
-- downloaded from `storage.from('invoices')`, but no migration ever created that
-- bucket and no code ever wrote pdf_key. lib/invoice-pdf.ts now renders, uploads
-- here and records pdf_key. This migration provisions the bucket it writes to.
--
-- The upload path treats a missing bucket as NON-fatal (it still sends the
-- rendered PDF and returns a warning), so applying this is required for the
-- SharePoint/AP byte-identity guarantee but is not a prerequisite for paying
-- anyone.

insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false)
on conflict (id) do nothing;

-- No BAM-facing policy on purpose.
--
-- A rendered invoice PDF contains the student's home address, bank name,
-- institution number, transit number and account number. The portal serves it
-- through /api/portal/invoices/download, which re-renders from payload_json
-- after an ownership check (see F3) — there is no reason to hand a browser a
-- direct object URL. Service-role bypasses RLS, which is how the senders read it.
--
-- Admins get read-only access for support/debugging. Nobody gets delete: an
-- invoice PDF is an accounting artefact (CLAUDE.md admin guardrail: no hard
-- deletes).

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage_invoices_admin_select'
  ) then
    create policy storage_invoices_admin_select
      on storage.objects for select
      using (
        bucket_id = 'invoices'
        and current_role_claim() in ('program_admin', 'super_admin')
      );
  end if;
end $$;

comment on column invoices.pdf_key is
  'Storage key in the private `invoices` bucket, written by lib/invoice-pdf.ts:ensureInvoicePdf on the first render. AP, SharePoint and the BAM copy all read THIS object so the three copies are byte-identical. Service-role only (0004 exempts service_role from the system-field guard).';
