/**
 * Next.js middleware — rate limiting + auth route protection.
 *
 * Auth: unauthenticated users are redirected away from /portal/* and /admin/*.
 * Dev mode bypasses auth checks so local testing works without Supabase session.
 *
 * Rate limiting uses in-memory Map (single-instance). For multi-instance deploys
 * on Vercel Pro, swap to Upstash Redis via @upstash/ratelimit.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

type Bucket = { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()

type Limit = { max: number; windowMs: number }
const LIMITS: Record<string, Limit> = {
  '/api/onboarding':      { max: 3,  windowMs: 24 * 60 * 60 * 1000 },
  '/api/auth/roster-check': { max: 5,  windowMs: 60 * 60 * 1000 },
  '/api/portal/upload':   { max: 30, windowMs: 24 * 60 * 60 * 1000 },
  '/api/portal/support':  { max: 10, windowMs: 60 * 60 * 1000 }
}

function rateLimit(req: NextRequest): NextResponse | null {
  const path = req.nextUrl.pathname
  const limit = LIMITS[path]
  if (!limit) return null

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
              ?? req.headers.get('x-real-ip') ?? 'unknown'
  const key = `${path}:${ip}`
  const now = Date.now()
  const b = buckets.get(key)

  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowMs })
    return null
  }
  if (b.count >= limit.max) {
    const retryAfter = Math.ceil((b.resetAt - now) / 1000)
    return NextResponse.json(
      { ok: false, message: 'Too many attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    )
  }
  b.count += 1
  return null
}

export async function middleware(req: NextRequest) {
  const rateLimitResult = rateLimit(req)
  if (rateLimitResult) return rateLimitResult

  const path = req.nextUrl.pathname
  // Dev bypass requires BOTH NODE_ENV=development AND an explicit opt-in flag,
  // so a misconfigured Vercel deploy (e.g. wrong NODE_ENV) can never skip auth.
  const isDevBypass = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'

  // Auth protection for portal and admin routes
  const needsPortalAuth = path.startsWith('/portal') && path !== '/portal/login' && path !== '/portal/onboarding' && path !== '/portal/faq' && path !== '/portal/program' && !path.startsWith('/portal/verify-account')
  const needsAdminAuth = path.startsWith('/admin')

  if (!needsPortalAuth && !needsAdminAuth) return NextResponse.next()
  if (isDevBypass) return NextResponse.next()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return NextResponse.next()

  const res = NextResponse.next()
  const supa = createServerClient(url, anon, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => {
        cookiesToSet.forEach(({ name, value, options }) => {
          res.cookies.set(name, value, options)
        })
      }
    }
  })

  const { data: { user } } = await supa.auth.getUser()

  const isApiRoute = path.startsWith('/api/')

  if (!user) {
    if (isApiRoute) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (needsPortalAuth || needsAdminAuth) {
      return NextResponse.redirect(new URL('/portal/login', req.url))
    }
  }

  if (needsAdminAuth && user) {
    const role = (user.user_metadata as { role?: string }).role
    if (!role || !['program_admin', 'super_admin'].includes(role)) {
      if (isApiRoute) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      }
      return NextResponse.redirect(new URL('/portal/login', req.url))
    }
  }

  return res
}

export const config = {
  matcher: [
    '/api/onboarding',
    '/api/auth/roster-check',
    '/api/portal/:path*',
    '/api/admin/:path*',
    '/portal/:path*',
    '/admin/:path*'
  ]
}
