/**
 * Resolves the signed-in BAM's id for the portal UI.
 *
 * P0-A: the portal pages used to read `user_metadata.bam_id`. That bag is
 * writable by the user's own session with the anon key, so even a "cosmetic"
 * read teaches the pattern that caused the privilege-escalation hole. Nothing
 * here is a security boundary (every server route resolves the BAM itself), but
 * the client should still read the trusted claim:
 *
 *   1. `app_metadata.bam_id` — service-role writable only, set by
 *      /api/auth/roster-check and onboarding-ingest, backfilled for existing
 *      users by 0016_auth_hardening.sql section 3d.
 *   2. `bams.auth_user_id` lookup — authoritative fallback for a session whose
 *      claim predates the backfill. RLS already limits this to the caller's own
 *      row, so it cannot be used to discover anyone else's id.
 *
 * Returns null when neither resolves; callers show "contact your program
 * manager" rather than guessing.
 */
import { getBamId } from './auth-claims'

type UserLike = { id: string; app_metadata?: unknown } | null | undefined

/**
 * Structurally minimal client shape. The builder chain is typed `any` on purpose:
 * threading the real generic PostgREST builder types through here makes tsc
 * report "Type instantiation is excessively deep" at the call sites, and this
 * helper only ever reads one column.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type BamLookupClient = { from: (table: string) => any }

export async function resolveBamId(sb: BamLookupClient, user: UserLike): Promise<string | null> {
  if (!user) return null

  const claimed = getBamId(user)
  if (claimed) return claimed

  const res = await sb.from('bams').select('id').eq('auth_user_id', user.id).maybeSingle()
  const row = res?.data as { id?: string } | null | undefined
  if (res?.error || !row?.id) return null
  return row.id
}
