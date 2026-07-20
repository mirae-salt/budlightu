/**
 * Next.js middleware — token-bucket rate limiting on sensitive routes.
 * Uses in-memory Map (single-instance). For multi-instance deploys on
 * Vercel Pro, swap to Upstash Redis via @upstash/ratelimit.
 *
 * Applied to:
 *   POST /api/onboarding      → 3 per IP per day (P0-3)
 *   POST /api/auth/otp        → 5 per IP per hour
 *   POST /api/receipts/upload → 30 per BAM per day
 */
import { NextRequest, NextResponse } from 'next/server'

type Bucket = { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()

type Limit = { max: number; windowMs: number }
const LIMITS: Record<string, Limit> = {
  '/api/onboarding':      { max: 3,  windowMs: 24 * 60 * 60 * 1000 },
  '/api/auth/otp':        { max: 5,  windowMs: 60 * 60 * 1000 },
  '/api/receipts/upload': { max: 30, windowMs: 24 * 60 * 60 * 1000 }
}

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname
  const limit = LIMITS[path]
  if (!limit) return NextResponse.next()

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
              ?? req.headers.get('x-real-ip') ?? 'unknown'
  const key = `${path}:${ip}`
  const now = Date.now()
  const b = buckets.get(key)

  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowMs })
    return NextResponse.next()
  }
  if (b.count >= limit.max) {
    const retryAfter = Math.ceil((b.resetAt - now) / 1000)
    return NextResponse.json(
      { ok: false, message: 'Too many attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    )
  }
  b.count += 1
  return NextResponse.next()
}

export const config = {
  matcher: ['/api/onboarding', '/api/auth/otp', '/api/receipts/upload']
}
