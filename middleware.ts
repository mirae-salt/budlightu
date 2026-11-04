// Authorship: Mirae Lee, BLU-MRL-20260720
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
import { ONBOARDING_MAX_PER_IP_PER_DAY } from './lib/rate-limits'

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
 * somebody's inbox. Keeping it the tightest of the five is the point, not the exact number.
 *
 * SECOND RAISE, later the same day: onboarding was not the only limit a shared network
 * trips. Someone testing on an office connection hit "Too many attempts" again, and the
 * four remaining entries were all still sized for one person at home:
 *
 *   upload           30/day  -> 200/day  one tester re-uploading to watch OCR spends ten
 *                                        of these alone, and a room shares the bucket
 *   support          10/hour ->  60/hour six testers sending two notes each was over it
 *   banking-request  10/day  ->  60/day  same arithmetic, and 0022 already allows only
 *                                        one OPEN request per BAM regardless of this
 *   roster-check     30/hour ->  60/hour still the tightest, because it sends OTP mail
 *
 * upload is the expensive one: every accepted file costs an OCR call. It is also behind
 * portal auth, so reaching it at all needs a real student session, and the per-file size
 * and type checks are in app/api/portal/upload. The IP ceiling is the outer fence, not
 * the only one, which is what makes 200 an acceptable number here.
 *
 * These buckets live in a per-instance Map, so on Vercel the effective ceiling is already
 * higher than what is written here and resets on every cold start. That cuts one way only:
 * it means these numbers can under-count real traffic, never over-count it.
 *
 * THIS TABLE IS NOT THE ONLY GATE, AND FOR ONBOARDING IT IS NOT THE DECIDING ONE.
 * supabase/functions/onboarding-ingest keeps its own durable per-IP count in audit_log.
 * It was hardcoded at 3 while this line said 100, so three people onboarded from one
 * office in 34 seconds and the fourth was refused for the day, hours after the limit
 * here had supposedly been raised. Both now read ONBOARDING_MAX_PER_IP_PER_DAY from
 * lib/rate-limits.ts. Before changing any number in this file, check whether the route
 * behind it counts for itself as well; `node scripts/probe/onboarding-limit.js` answers
 * that for onboarding.
 */
const LIMITS: Record<string, Limit> = {
  '/api/onboarding':      { max: ONBOARDING_MAX_PER_IP_PER_DAY, windowMs: 24 * 60 * 60 * 1000 },
  '/api/auth/roster-check': { max: 60, windowMs: 60 * 60 * 1000 },
  '/api/portal/upload':   { max: 200, windowMs: 24 * 60 * 60 * 1000 },
  '/api/portal/support':  { max: 60, windowMs: 60 * 60 * 1000 },
  // Banking corrections are rare per person, but the bucket is the whole room.
  // The database also allows only one open request per BAM (0022), which is the
  // limit that actually matters; this is the outer fence on submission attempts.
  '/api/portal/banking-request': { max: 60, windowMs: 24 * 60 * 60 * 1000, methods: ['POST'] }
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
      const loginUrl = new URL('/portal/login', req.url)
      if (path === '/portal/support') loginUrl.searchParams.set('next', '/portal/support')
      return NextResponse.redirect(loginUrl)
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
