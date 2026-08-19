/**
 * Q: Can one signed-in student read another student's row?
 *
 * WHY THIS IS DIFFERENT FROM tests/rls-shape.test.ts
 * --------------------------------------------------
 * That suite reads the migration FILES and asserts the policy text is present. It is
 * useful and it cannot answer this question: a policy can exist, be syntactically fine,
 * and still not do what it looks like it does. Its own header says as much and asks for
 * exactly this companion check.
 *
 * Every other probe in this folder runs as service role, which BYPASSES RLS entirely.
 * So none of them can test RLS either. This one signs in as a real user and queries with
 * the ANON key, which is the path a student's browser actually takes.
 *
 * READ-ONLY. It issues selects, never writes. Sessions are created through the admin API
 * (generateLink + verifyOtp) rather than by setting a password on anyone.
 *
 * The promise being tested is the one the whole program rests on: 58 students share a
 * database and must not be able to see each other's banking details.
 *
 * Usage:  node scripts/probe/rls-enforced.js
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */
const { createClient } = require('@supabase/supabase-js')
const { serviceClient, loadEnv, pass, fail, info, verdict } = require('./_lib')

/** Sign in as `email` without touching their password, and return an anon-key client. */
async function sessionFor(admin, url, anonKey, email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) return { error: `generateLink failed: ${error.message}` }
  const tokenHash = data?.properties?.hashed_token
  if (!tokenHash) return { error: 'no hashed_token returned' }

  const client = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: v, error: vErr } = await client.auth.verifyOtp({ type: 'email', token_hash: tokenHash })
  if (vErr) return { error: `verifyOtp failed: ${vErr.message}` }
  if (!v?.session) return { error: 'no session returned' }
  return { client, userId: v.user.id }
}

async function main() {
  loadEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    fail('NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY missing from .env.local')
    return verdict('RLS enforced')
  }

  const admin = serviceClient()

  const { data: rows, error: bamErr } = await admin
    .from('bams')
    .select('id, email, first_name, auth_user_id, is_test')
    .eq('is_test', true).eq('status', 'active')
    .not('auth_user_id', 'is', null)
    .order('email')
  if (bamErr) { fail(`roster read failed: ${bamErr.message}`); return verdict('RLS enforced') }

  /*
   * ADMINS ARE EXCLUDED, and getting this wrong invalidates the whole run.
   *
   * Several people hold both an admin role and a TEST roster row (see CLAUDE.md: adding
   * an admin also creates one). An admin is SUPPOSED to read every student, so signing in
   * as one and finding the whole roster proves nothing. The first version of this probe
   * picked alphabetically, landed on a super_admin, and reported seven tables "leaked" —
   * which was the system working correctly.
   *
   * The question is only meaningful for an account whose role is `bam`.
   */
  const { data: authList } = await admin.auth.admin.listUsers({ perPage: 200 })
  const roleOf = email => {
    const u = (authList?.users ?? []).find(x => String(x.email).toLowerCase() === String(email).toLowerCase())
    return u?.app_metadata?.role || u?.user_metadata?.role || 'bam'
  }
  const students = (rows ?? []).filter(b => roleOf(b.email) === 'bam')
  const skipped = (rows ?? []).filter(b => roleOf(b.email) !== 'bam')
  if (skipped.length) info(`skipping ${skipped.length} admin account(s): ${skipped.map(s => `${s.email} (${roleOf(s.email)})`).join(', ')}`)

  if (students.length < 2) {
    fail(`need 2 non-admin test BAMs with logins, found ${students.length}`)
    info('an admin reading every student is correct behaviour, so admins cannot answer this')
    return verdict('RLS enforced')
  }

  const me = students[0]
  const other = students.find(b => b.id !== me.id)
  info(`signing in as   ${me.email}`)
  info(`will try to read ${other.email}`)
  info('')

  const s = await sessionFor(admin, url, anonKey, me.email)
  if (s.error) { fail(s.error); return verdict('RLS enforced') }
  const as = s.client

  let leaks = 0

  // --- can they see themselves? A policy that denies everything would also "pass" the
  // cross-user checks below, so prove the happy path first or the result is meaningless.
  const own = await as.from('bams').select('id, email').eq('id', me.id)
  if (own.error) { fail(`cannot read OWN row: ${own.error.message} — RLS may be too strict`) }
  else if ((own.data ?? []).length === 1) pass('can read their own roster row')
  else fail(`own row returned ${(own.data ?? []).length} rows — expected 1`)

  // --- the actual question -------------------------------------------------------
  const checks = [
    ['bams', () => as.from('bams').select('id, email').eq('id', other.id)],
    ['receipts', () => as.from('receipts').select('id').eq('bam_id', other.id)],
    ['invoices', () => as.from('invoices').select('id, invoice_number').eq('bam_id', other.id)],
    ['reimbursement_ledger', () => as.from('reimbursement_ledger').select('id').eq('bam_id', other.id)],
    ['banking_change_requests', () => as.from('banking_change_requests').select('id').eq('bam_id', other.id)],
    ['bam_notifications', () => as.from('bam_notifications').select('id').eq('bam_id', other.id)],
    ['portal_questions', () => as.from('portal_questions').select('id').eq('bam_id', other.id)],
  ]

  for (const [table, run] of checks) {
    const { data, error } = await run()
    if (error) {
      // A refusal is a pass: the row was not handed over.
      pass(`${table.padEnd(24)} denied (${error.message.slice(0, 44)})`)
      continue
    }
    const n = (data ?? []).length
    if (n === 0) pass(`${table.padEnd(24)} 0 rows — cannot see the other BAM`)
    else { fail(`${table.padEnd(24)} LEAKED ${n} row(s) belonging to ${other.email}`); leaks++ }
  }

  // --- the whole roster, unfiltered. The check above pins one id; this asks for everything.
  const all = await as.from('bams').select('id, email')
  if (all.error) pass('whole-table select denied')
  else {
    const foreign = (all.data ?? []).filter(r => r.id !== me.id)
    if (foreign.length === 0) pass(`whole-table select returned only their own row`)
    else { fail(`whole-table select LEAKED ${foreign.length} other BAM(s): ${foreign.map(f => f.email).join(', ')}`); leaks++ }
  }

  // --- banking. The most sensitive column set in the system.
  const bank = await as.from('bams')
    .select('id, bank_name, institution_no, transit_no, account_no').eq('id', other.id)
  if (bank.error) pass(`banking columns denied (${bank.error.message.slice(0, 40)})`)
  else if ((bank.data ?? []).length === 0) pass("banking columns 0 rows for the other BAM")
  else { fail(`BANKING LEAKED for ${other.email}`); leaks++ }

  await as.auth.signOut()
  info('')
  info('read-only: nothing was written. Sessions were created via admin generateLink.')
  if (leaks) fail(`${leaks} table(s) leaked across students`)
  else pass('no cross-student read succeeded')
  verdict('RLS enforced')
}
main()
