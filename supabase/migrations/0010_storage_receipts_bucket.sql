-- Create receipts storage bucket + RLS policies
-- Bucket must also be created via Supabase Dashboard or CLI:
--   INSERT INTO storage.buckets (id, name, public) VALUES ('receipts', 'receipts', false);

-- BAMs can upload to their own folder
create policy storage_receipts_bam_insert
  on storage.objects for insert
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (
      select id::text from bams where auth_user_id = auth.uid() limit 1
    )
  );

-- BAMs can read their own files
create policy storage_receipts_bam_select
  on storage.objects for select
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (
      select id::text from bams where auth_user_id = auth.uid() limit 1
    )
  );

-- Admins can read all receipt files
create policy storage_receipts_admin_select
  on storage.objects for select
  using (
    bucket_id = 'receipts'
    and coalesce(current_setting('request.jwt.claim.role', true), 'bam') in ('program_admin', 'super_admin')
  );

-- Admins can delete receipt files (cleanup)
create policy storage_receipts_admin_delete
  on storage.objects for delete
  using (
    bucket_id = 'receipts'
    and coalesce(current_setting('request.jwt.claim.role', true), 'bam') in ('program_admin', 'super_admin')
  );
