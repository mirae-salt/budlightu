/** Browser-side Supabase client (uses anon key). RLS enforces access. */
import { createBrowserClient } from '@supabase/ssr'

export function browserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createBrowserClient(url, anon)
}
