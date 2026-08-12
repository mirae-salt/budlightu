/**
 * Q: What does a signed-in student actually get on each portal page?
 *
 * Every portal page behind the login was unverifiable until now. The browser cannot
 * reach them without a session, so mobile layout and page content both rested on
 * reading the code. That is how /portal/invoices shipped a 480px table with no scroll
 * container: nothing had ever rendered it.
 *
 * This mints a real session for a TEST BAM the way whoami-as.js does, fetches each page
 * as that student, and reports what came back. It checks the HTML rather than a live
 * layout, so it cannot measure pixel widths -- what it CAN do is catch a page that 500s,
 * redirects, renders an error, or is missing the markup that keeps a wide table from
 * pushing the page sideways.
 *
 * READ-ONLY. Every request is a GET. Nothing is submitted.
 *
 * TEST ACCOUNTS ONLY. It refuses an email that is not `is_test`, so it can never mint a
 * session for a real student.
 *
 *   node scripts/probe/student-pages.js                    # against production
 *   BASE=http://localhost:3000 node scripts/probe/student-pages.js
 */
const path = require('path')
const { ROOT, loadEnv, serviceClient, pass, fail, info, verdict } = require('./_lib')

const BASE = process.env.BASE || 'https://budlightu.com'

/** Pages a student reaches after signing in. */
const PAGES = [
  { path: '/portal/dashboard', expect: 'Welcome back' },
  { path: '/portal/upload', expect: 'Submitting for' },
  { path: '/portal/invoices', expect: null },
  { path: '/portal/account', expect: null },
  { path: '/portal/support', expect: null },
  { path: '/portal/faq', expect: null },
  { path: '/portal/terms', expect: null },
  { path: '/portal/program', expect: null }
]

async function mintSession(email) {
  loadEnv()
  const { createClient } = require(path.join(ROOT, 'node_modules', '@supabase', 'supabase-js'))
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } })

  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) throw new Error(`generateLink(${email}): ${error.message}`)

  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } })

  // The 6-digit code, not the hashed link token. generateLink returns both, and
  // `verifyOtp({ token_hash, type: 'magiclink' })` fails here with "Email link is
  // invalid or has expired" -- the same magic-link trouble that made this project move
  // to codes in the first place (CLAUDE.md, 2026-07-20). The code path is also the one
  // a real student uses, so exercising it is worth more.
  const { data: sess, error: vErr } = await anon.auth.verifyOtp({
    email,
    token: data.properties.email_otp,
    type: 'email'
  })
  if (vErr) throw new Error(`verifyOtp(${email}): ${vErr.message}`)
  if (!sess.session) throw new Error(`verifyOtp(${email}) returned no session`)
  return sess.session
}

function headersFor(session) {
  loadEnv()
  const m = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').match(/https:\/\/([^.]+)\./)
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64')
  return {
    Authorization: `Bearer ${session.access_token}`,
    ...(m ? { Cookie: `sb-${m[1]}-auth-token=${value}` } : {})
  }
}

async function main() {
  const db = serviceClient()

  // A test account only. Minting a session for a real student would be borrowing their
  // identity to look at their data.
  const { data: bams, error } = await db
    .from('bams').select('email, status, is_test').eq('is_test', true).eq('status', 'active').limit(1)
  if (error) { fail('bams read: ' + error.message); return verdict('student pages') }
  const bam = (bams ?? [])[0]
  if (!bam) {
    fail('no active test BAM to sign in as. Run fix-admin-test-bams.js first.')
    return verdict('student pages')
  }

  let session
  try {
    session = await mintSession(bam.email)
  } catch (e) {
    fail('could not mint a session: ' + (e && e.message ? e.message : String(e)))
    return verdict('student pages')
  }
  const headers = headersFor(session)

  info(`signed in as a TEST account against ${BASE}`)
  console.log('')

  for (const p of PAGES) {
    let res, html
    try {
      res = await fetch(BASE + p.path, { headers, redirect: 'manual' })
      html = res.status < 400 ? await res.text() : ''
    } catch (e) {
      fail(`${p.path.padEnd(22)} request failed: ${e.message}`)
      continue
    }

    // A redirect here means the session was not accepted, which would make every other
    // line meaningless -- the same trap whoami-as.js was built wrong for once.
    if (res.status >= 300 && res.status < 400) {
      fail(`${p.path.padEnd(22)} ${res.status} redirect to ${res.headers.get('location')} (session not accepted)`)
      continue
    }
    if (res.status !== 200) {
      fail(`${p.path.padEnd(22)} HTTP ${res.status}`)
      continue
    }

    const problems = []

    // The mobile hazard: globals.css gives every .admin-table a min-width of 600px, so
    // one outside a scrolling container pushes the whole page sideways on a phone.
    const tables = (html.match(/class="[^"]*admin-table/g) || []).length
    if (tables > 0) {
      const wrapped = html.includes('table-scroll') || /overflow-x:\s*auto/i.test(html)
      if (!wrapped) problems.push(`${tables} wide table(s) with no scroll container`)
    }
    // These are client components, so their content is fetched in the browser and the
    // server HTML contains neither the table nor the empty state. "0 tables" therefore
    // means "not visible from here", NOT "checked and fine". Saying which is which is
    // the whole point: a probe that overstates is worse than one that admits a gap.
    const knownTablePage = p.path === '/portal/invoices' || p.path === '/portal/account'
    const clientRendered = tables === 0 && knownTablePage

    // A page that rendered its own error state is a 200 that is not working.
    //
    // Narrow on purpose. The first version also matched "contact your program manager",
    // which flagged /portal/terms -- where that sentence is the actual agreement text,
    // twice over. A detector that cries wolf gets ignored, which is the failure this
    // whole probe kit exists to avoid.
    if (/Something went wrong|We could not load|could not be loaded/i.test(html)) {
      problems.push('renders an error message')
    }
    if (p.expect && !html.includes(p.expect)) {
      problems.push(`missing expected content "${p.expect}"`)
    }

    if (problems.length > 0) fail(`${p.path.padEnd(22)} 200 but: ${problems.join('; ')}`)
    else if (clientRendered) {
      info(`${p.path.padEnd(22)} 200, but its table is client-rendered so this probe CANNOT check it`)
    } else if (tables > 0) {
      pass(`${p.path.padEnd(22)} 200, ${tables} table(s) all wrapped, no error state`)
    } else {
      pass(`${p.path.padEnd(22)} 200, no error state`)
    }
  }

  console.log('')
  info('server HTML only. It cannot measure pixel widths, and on a client-rendered page')
  info('it cannot see the table at all -- those lines say so rather than passing.')
  info('a real phone is still the only way to test the camera and file picker.')
  verdict('student pages')
}
main()
