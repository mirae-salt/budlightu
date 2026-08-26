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
import { getRole, isAdminRole, detectRoleTampering } from './lib/auth-claims'
import { needsPortalAuth, needsAdminAuth } from './lib/route-gate'

type Bucket = { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()

/**
 * `methods` narrows a limit to specific verbs. Omitted means every verb, which
 * is what every pre-existing entry below relies on. It exists because the
 * banking-request endpoint is also read by its own page on load: counting those
 * GETs would lock a student out of simply looking at their details.
 */
type Limit = { max: number; windowMs: number; methods?: string[] }
/*
 * THESE ARE KEYED BY IP, SO A SHARED OFFICE OR CAMPUS IS ONE BUCKET.
 *
 * That is the thing to hold in mind before lowering any of them. Onboarding was 3 per
 * IP per day, which is right for one person at home and wrong for the two situations
 * this product actually has: a room of testers going through the flow together, and
 * an onboarding day where a cohort signs up from the same campus network. In both, the
 * fourth person got "Too many attempts" and had to wait 24 hours.
 *
 * Raised on 2026-08-26, before a live testing session with several people in one room.
 * The invite token is the real gate on onboarding: /api/onboarding cannot be used at
 * all without a valid `invite_token_hash`, and the token carries its own attempt limit,
 * so the IP ceiling is a second fence rather than the only one.
 *
 * Onboarding is 100 a day rather than something tighter because of what September 1
 * looks like: 58 students signing up around the same time, some of them on one campus
 * network, and a form people get wrong once before they get it right. Each retry spends
 * a request. Running out on onboarding day would look like the portal being broken.
 *
 * roster-check is deliberately lower than onboarding. It sends an OTP email, so it is
 * the one an attacker could use to probe which addresses are on the roster or to bury
 * somebody's inbox. 30 an hour still covers a full room signing in together while
 * keeping that narrow.
 */
const LIMITS: Record<string, Limit> = {
  '/api/onboarding':      { max: 100, windowMs: 24 * 60 * 60 * 1000 },
  '/api/auth/roster-check': { max: 30, windowMs: 60 * 60 * 1000 },
  '/api/portal/upload':   { max: 30, windowMs: 24 * 60 * 60 * 1000 },
  '/api/portal/support':  { max: 10, windowMs: 60 * 60 * 1000 },
  // Banking corrections are rare by nature. The database also allows only one
  // open request per BAM (0022); this is the outer fence on submission attempts.
  '/api/portal/banking-request': { max: 10, windowMs: 24 * 60 * 60 * 1000, methods: ['POST'] }
}

function rateLimit(req: NextRequest): NextResponse | null {
  const path = req.nextUrl.pathname
  const limit = LIMITS[path]
  if (!limit) return null
  if (limit.methods && !limit.methods.includes(req.method)) return null

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

function isApiPath(path: string): boolean {
  return path.startsWith('/api/')
}

/**
 * Response used when the server cannot evaluate authorization at all.
 * 503 rather than 401 so the cause is obvious in logs and to the operator:
 * this is our misconfiguration, not the visitor's problem.
 */
function configErrorResponse(isApi: boolean): NextResponse {
  if (isApi) {
    return NextResponse.json(
      { ok: false, error: 'server_misconfigured', message: 'Server is not configured. Contact your program manager.' },
      { status: 503 }
    )
  }
  return new NextResponse(
    '<!doctype html><meta charset="utf-8"><title>Unavailable</title>' +
    '<body style="font-family:system-ui;padding:48px;max-width:520px;margin:0 auto">' +
    '<h1 style="font-size:20px">This page is temporarily unavailable</h1>' +
    '<p style="color:#555;font-size:14px">The server is missing part of its configuration, so we cannot verify your access. ' +
    'Nothing is wrong with your account. Please contact your program manager.</p></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}

export async function middleware(req: NextRequest) {
  const rateLimitResult = rateLimit(req)
  if (rateLimitResult) return rateLimitResult

  const path = req.nextUrl.pathname
  // Dev bypass requires BOTH NODE_ENV=development AND an explicit opt-in flag,
  // so a misconfigured Vercel deploy (e.g. wrong NODE_ENV) can never skip auth.
  const isDevBypass = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'

  // Which paths require a session lives in lib/route-gate.ts, as a pure function with
  // tests. It used to be one long boolean here, and that is where the invite link got
  // broken: the onboarding exemption was an exact match, so /portal/onboarding/<token>
  // counted as protected and every new BAM hit a login wall.
  const portalAuth = needsPortalAuth(path)
  const adminAuth = needsAdminAuth(path)

  if (!portalAuth && !adminAuth) return NextResponse.next()
  if (isDevBypass) return NextResponse.next()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // P0-A2: fail CLOSED. This used to be `return NextResponse.next()`, which
  // meant one missing env var on a deploy turned every /admin and /portal route
  // into an unauthenticated route. A misconfigured server is a denied server.
  if (!url || !anon) {
    console.error('[middleware] Supabase env vars missing. Denying all protected routes.')
    return configErrorResponse(isApiPath(path))
  }

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

  // P0-H: inspect the error. supabase-js does not throw, and a failed getUser
  // returns `user: null`, which already denies; destructuring the error makes
  // the reason visible instead of looking like "not signed in".
  const { data: authData, error: authError } = await supa.auth.getUser()
  if (authError) {
    console.error('[middleware] getUser failed:', authError.message)
  }
  const user = authData?.user ?? null

  const isApiRoute = isApiPath(path)

  if (!user) {
    if (isApiRoute) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (portalAuth || adminAuth) {
      return NextResponse.redirect(new URL('/portal/login', req.url))
    }
  }

  if (adminAuth && user) {
    // P0-A: `app_metadata` only. `user_metadata` is writable by the user's own
    // session, so reading a role from it let any BAM self-promote to super_admin.
    // There is no fallback: an absent claim denies.
    const role = getRole(user)

    const tamper = detectRoleTampering(user)
    if (tamper.tampered) {
      console.error(
        `[middleware] SECURITY: user ${user.id} carries user_metadata.role="${tamper.claimed}" ` +
        `but trusted app_metadata role is "${role ?? 'none'}". Ignoring the client claim.`
      )
    }

    if (!isAdminRole(role)) {
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
