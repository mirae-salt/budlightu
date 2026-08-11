/**
 * Q: Which SECURITY DEFINER functions can a browser-key caller execute?
 *
 * `encrypt_bam_banking` and `get_onboarding_summary` are SECURITY DEFINER, so they
 * run as their owner and bypass RLS. Whether that is safe depends entirely on who
 * holds EXECUTE, and CREATE FUNCTION grants EXECUTE TO PUBLIC by default. Reading
 * the migration cannot answer it: a REVOKE could have been run out of band, and an
 * applied migration that never revokes leaves the default in place.
 *
 * There is no psql and no `supabase db execute` here, so this asks PostgREST
 * directly with the ANON key -- the same key that ships in the browser bundle.
 *
 * SAFE BY CONSTRUCTION: every call targets a random uuid that cannot exist, so a
 * function that DOES execute updates zero rows. The only thing observed is whether
 * the call is refused. No real record is read or written, and no value is printed.
 *
 * Usage: node scripts/probe/rpc-grants.js
 */
const path = require('path')
const { ROOT, loadEnv, pass, fail, info, verdict } = require('./_lib')

const NOWHERE = '00000000-0000-4000-8000-0000000000ff'  // valid uuid, no such row

async function main() {
  loadEnv()
  const { createClient } = require(path.join(ROOT, 'node_modules', '@supabase', 'supabase-js'))
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) { fail('NEXT_PUBLIC_SUPABASE_URL or _ANON_KEY missing'); return verdict('rpc grants') }

  const sb = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } })

  // name -> args. Each must be harmless if it DOES run.
  const cases = [
    { name: 'encrypt_bam_banking', args: { p_bam_id: NOWHERE, p_institution_no: null, p_transit_no: null, p_account_no: null, p_hst_number: null }, why: 'rewrites a payout destination' },
    { name: 'decrypt_bam_banking', args: { p_bam_id: NOWHERE }, why: 'reads banking in cleartext' },
    { name: 'get_onboarding_summary', args: {}, why: 'lists every parked onboarding submission' },
    { name: 'encrypt_banking_request', args: { p_request_id: NOWHERE, p_institution_no: null, p_transit_no: null, p_account_no: null }, why: 'writes a pending banking change' }
  ]

  for (const c of cases) {
    const { error } = await sb.rpc(c.name, c.args)
    const msg = (error && (error.message || '')) || ''
    const code = (error && error.code) || ''
    const denied = /permission denied|not allowed|must be owner/i.test(msg)
    const absent = /could not find the function|does not exist|schema cache/i.test(msg)

    if (absent) {
      info(`${c.name.padEnd(26)} not present in this database`)
    } else if (denied) {
      pass(`${c.name.padEnd(26)} DENIED to the anon key (${code || 'no code'})`)
    } else if (error) {
      // An error that is NOT a permission error means the call got past the grant.
      fail(`${c.name.padEnd(26)} EXECUTABLE by the anon key -- it ${c.why}. Ran and failed later: ${msg.slice(0, 120)}`)
    } else {
      fail(`${c.name.padEnd(26)} EXECUTABLE by the anon key -- it ${c.why}. Returned no error.`)
    }
  }

  console.log('')
  info('anon key only. A signed-in student holds this same key plus a session, so')
  info('anything the anon key can execute, every student can execute.')
  info('targets a uuid that cannot exist, so nothing was read or written.')
  verdict('rpc grants')
}
main()
