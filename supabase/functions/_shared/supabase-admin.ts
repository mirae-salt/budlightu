/**
 * Shared Supabase service-role client for Edge Functions.
 * Only used server-side. Never expose SERVICE_ROLE_KEY to browser code.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? Deno?.env?.get?.('SUPABASE_URL')
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? Deno?.env?.get?.('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('Supabase env vars missing')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

// tiny declare for Deno runtime tolerance in Node tsc
declare global {
  namespace Deno {
    const env: { get(name: string): string | undefined } | undefined
  }
}
export {}
