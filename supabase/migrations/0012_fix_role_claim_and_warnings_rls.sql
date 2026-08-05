-- Fix current_role_claim() to read from user_metadata (where the app stores roles)
-- instead of the top-level JWT claim which is not set by our auth flow.
create or replace function current_role_claim() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (auth.jwt()->'user_metadata'->>'role'),
    'bam'
  )
$$;

-- Add admin RLS policy for bam_warnings (was missing — only service_role existed)
create policy "admins full access on bam_warnings"
  on bam_warnings for all
  using (current_role_claim() in ('program_admin', 'super_admin'))
  with check (current_role_claim() in ('program_admin', 'super_admin'));
