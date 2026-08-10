/**
 * Q: What can each role actually reach?
 *
 * A7: admin credentials bypass row permissions, so a service-role query can
 * neither confirm nor refute a permission claim. This mints a REAL session for a
 * real principal and calls the deployed app with it.
 *
 * Runs against production by default, because .env.local sets
 * ALLOW_DEV_AUTH_BYPASS=true and NODE_ENV=development, which makes every admin
 * route accept an unauthenticated request locally. Testing localhost would report
 * a false PASS on the exact thing being tested.
 *
 * SAFETY: GET only. A POST could act if authorization turned out to be broken,
 * which is precisely the case under test. Read routes are where a leak shows up.
 *
 * Usage:
 *   node scripts/probe/whoami-as.js                      anonymous sweep
 *   node scripts/probe/whoami-as.js <email>              sweep as that principal
 *   BASE=http://localhost:3000 node scripts/probe/whoami-as.js
 */
const { loadEnv, pass, fail, info, verdict } = require('./_lib')
const path = require('path')

const BASE = process.env.BASE || 'https://budlightu.com'

/**
 * GET endpoints and who may pass authorization.
 *
 * `allow` is about AUTHORIZATION only. Authorization answers with 401 or 403;
 * any other status means the request got past the gate and failed for its own
 * reasons (no data, wrong method, missing table). Conflating those produced four
 * false alarms on the first run, and a probe that cries wolf gets ignored, which
 * is the failure this whole kit exists to prevent.
 *
 * /api/admin/notifications is deliberately absent: it is POST-only (mark-read).
 * Notifications are READ through /api/admin/data?table=notifications.
 */
const ROUTES = [
  { url: '/api/admin/data?table=bams',      allow: ['admin'] },
  { url: '/api/admin/data?table=invoices',  allow: ['admin'] },
  { url: '/api/admin/data?table=notifications', allow: ['admin'] },
  { url: '/api/admin/banking-requests',     allow: ['admin'], needs: '0022' },
  { url: '/api/admin/team',                 allow: ['admin'] },
  { url: '/api/admin/warnings',             allow: ['admin'] },
  { url: '/api/verify-account/tail',        allow: ['admin', 'bam'] },
  { url: '/api/portal/banking-request',     allow: ['admin', 'bam'], needs: '0022' },
]

async function sessionFor(email) {
  loadEnv()
  const root = path.resolve(__dirname, '..', '..')
  const { createClient } = require(path.join(root, 'node_modules', '@supabase', 'supabase-js'))
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } })

  // generateLink gives a verifiable token without needing the mailbox.
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) throw new Error(`generateLink(${email}): ${error.message}`)

  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: sess, error: vErr } = await anon.auth.verifyOtp({
    token_hash: data.properties.hashed_token, type: 'magiclink'
  })
  if (vErr) throw new Error(`verifyOtp(${email}): ${vErr.message}`)

  const role = (sess.user.app_metadata && sess.user.app_metadata.role) || 'none'
  return { session: sess.session, role, email }
}

/**
 * Build the auth cookie the way @supabase/ssr reads it.
 *
 * 0.5.2 stores the whole session as JSON, base64-encoded, behind a literal
 * `base64-` prefix (see node_modules/@supabase/ssr/dist/main/cookies.js).
 * Sending raw JSON instead produced "Not signed in.", which made an
 * unauthenticated sweep look like a correctly-denied BAM sweep: six meaningless
 * PASS lines. Hence assertAuthenticated below.
 */
function headersFor(session) {
  if (!session) return {}
  loadEnv()
  const m = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').match(/https:\/\/([^.]+)\./)
  if (!m) return { Authorization: `Bearer ${session.access_token}` }
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64')
  return {
    Authorization: `Bearer ${session.access_token}`,
    Cookie: `sb-${m[1]}-auth-token=${value}`
  }
}

/**
 * A denial only means something if the request was actually signed in. Prove it
 * before trusting any "denied, as expected" line.
 */
async function assertAuthenticated(who) {
  const resp = await fetch(BASE + '/api/verify-account/tail', { headers: headersFor(who.session), redirect: 'manual' })
  const body = (await resp.text()).replace(/\s+/g, ' ').slice(0, 120)
  if (resp.status === 401 && /not signed in/i.test(body)) {
    fail(`session was NOT accepted by the app (${resp.status} ${body}).`)
    info('every "denied" below would then be an anonymous denial and would prove nothing')
    return false
  }
  pass(`session accepted by the app (probe is genuinely signed in as ${who.email})`)
  return true
}

async function main() {
  const email = process.argv[2]
  let who = { session: null, role: 'anonymous', email: '(anonymous)' }
  if (email) {
    try { who = await sessionFor(email) }
    catch (e) { fail(e.message); return verdict('whoami-as') }
  }

  const kind = who.role === 'super_admin' || who.role === 'program_admin' ? 'admin'
    : who.role === 'bam' ? 'bam' : 'anonymous'

  info(`BASE=${BASE}`)
  info(`principal: ${who.email}  app_metadata.role=${who.role}  treated as: ${kind}`)
  console.log('')

  // Without this gate a broken session silently turns the whole sweep into an
  // anonymous sweep whose every denial looks like a correct authorization result.
  if (who.session && !(await assertAuthenticated(who))) return verdict('whoami-as (session rejected)')
  console.log('')

  for (const r of ROUTES) {
    let status, snippet = ''
    try {
      const resp = await fetch(BASE + r.url, { headers: headersFor(who.session), redirect: 'manual' })
      status = resp.status
      const body = (await resp.text()).replace(/\s+/g, ' ').slice(0, 90)
      snippet = body
    } catch (e) {
      fail(`${r.url.padEnd(38)} request failed: ${e.message}`)
      continue
    }

    const denied = status === 401 || status === 403
    const shouldAllow = r.allow.includes(kind)
    const label = r.url.padEnd(44)

    if (!denied && !shouldAllow) {
      fail(`${label} ${status} LEAK: ${kind} passed authorization here. body: ${snippet}`)
    } else if (denied && shouldAllow) {
      fail(`${label} ${status} WRONGLY DENIED for ${kind}. body: ${snippet}`)
    } else if (denied) {
      pass(`${label} ${status} denied, as expected`)
    } else if (status >= 200 && status < 300) {
      pass(`${label} ${status} allowed, as expected`)
    } else if (r.needs) {
      pass(`${label} ${status} authorized; fails on unapplied migration ${r.needs}`)
    } else {
      pass(`${label} ${status} authorized; non-auth error (see body): ${snippet}`)
    }
  }

  console.log('')
  info('GET only by design: a POST could act if authorization is broken, which is what is under test')
  info('this cannot prove RLS on rows the app never queries; it tests the app surface')
  verdict(`whoami-as ${kind}`)
}
main()
