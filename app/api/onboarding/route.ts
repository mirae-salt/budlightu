/** POST /api/onboarding — server-side thin wrapper around the Supabase Edge Function.
 *  Keeps SERVICE_ROLE_KEY off the client. Rate-limit metadata pulled from headers.
 */
import { NextRequest, NextResponse } from 'next/server'
import { handler } from '../../../supabase/functions/onboarding-ingest/index'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
    const res = await handler({ ...body, ip })
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 500 })
  }
}
