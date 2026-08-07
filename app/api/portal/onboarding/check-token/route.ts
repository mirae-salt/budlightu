/**
 * GET /api/portal/onboarding/check-token?token=...
 *
 * Lightweight upfront check so the token-gated onboarding page can tell
 * a BAM their invite link is dead BEFORE they fill out the whole form
 * (P1 fix — previously the failure only surfaced on final submit).
 *
 * Does NOT burn the token or mutate any state — read-only lookup against
 * `bams.invite_token_hash` where status = 'pending'. The token is only
 * actually consumed by the real submit (`onboarding-ingest` edge function).
 *
 * TTL: tokens expire 7 days after issuance (based on `updated_at`).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  if (!token) {
    return NextResponse.json({ ok: false })
  }

  const tokenHash = createHash('sha256').update(token).digest('hex')
  const db = serviceClient()

  const { data: pendingBam, error } = await db
    .from('bams')
    .select('first_name, last_name, email, updated_at')
    .eq('invite_token_hash', tokenHash)
    .eq('status', 'pending')
    .single()

  if (error || !pendingBam) {
    return NextResponse.json({ ok: false })
  }

  const issuedAt = new Date(pendingBam.updated_at).getTime()
  if (Date.now() - issuedAt > TOKEN_TTL_MS) {
    return NextResponse.json({ ok: false, expired: true })
  }

  return NextResponse.json({ ok: true, first_name: pendingBam.first_name ?? null, last_name: pendingBam.last_name ?? null, email: pendingBam.email ?? null })
}
