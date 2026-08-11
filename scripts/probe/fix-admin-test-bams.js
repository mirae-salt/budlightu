/**
 * Gives every EXISTING admin a test BAM account.
 *
 * Adding an admin now creates one automatically (lib/admin-test-bam.ts), but Robin
 * and Nathan were added before that existed, so they have an admin role and no roster
 * row. They can sign in and use /admin, but every portal page shows them an empty
 * state, so they cannot test the student journey.
 *
 * WRITES. Run with --dry-run first (that is the default). Pass --apply to write.
 *
 * Uses the same ensureTestBam() the admin-add route uses, so there is one copy of
 * the rule. In particular it will refuse to put a test row in a live cohort.
 *
 *   node scripts/probe/fix-admin-test-bams.js            # show what would change
 *   node scripts/probe/fix-admin-test-bams.js --apply    # do it
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const APPLY = process.argv.includes('--apply')
const ADMIN_ROLES = ['super_admin', 'program_admin']

// The REAL routine the admin-add route uses, loaded from the app. In particular it
// refuses to put a test roster row in a live cohort, which would put an admin into
// the monthly invoice run.
const { ensureTestBam } = loadTs('lib/admin-test-bam.ts')
if (typeof ensureTestBam !== 'function') {
  console.error('FAIL  could not load ensureTestBam from lib/admin-test-bam.ts')
  process.exit(1)
}

async function main() {
  const db = serviceClient()

  const { data: users, error: uErr } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (uErr) { fail('listUsers: ' + uErr.message); return verdict('admin test accounts') }

  const { data: bams, error: bErr } = await db.from('bams').select('id, email, auth_user_id, status, is_test')
  if (bErr) { fail('bams read: ' + bErr.message); return verdict('admin test accounts') }

  const norm = e => String(e || '').trim().toLowerCase()
  const admins = users.users.filter(u => ADMIN_ROLES.includes((u.app_metadata || {}).role))

  const missing = []
  for (const u of admins) {
    const email = norm(u.email)
    const row = bams.find(b => norm(b.email) === email)
    const meta = u.user_metadata || {}
    const target = {
      userId: u.id,
      email,
      firstName: String(meta.first_name || email.split('@')[0]),
      lastName: String(meta.last_name || 'Admin')
    }
    if (!row) {
      info(`${email.padEnd(32)} NEEDS a test BAM account (${target.firstName} ${target.lastName})`)
      missing.push(target)
    } else if (row.is_test === true) {
      // Existing test rows still get topped up: address and banking are what make
      // the invoice chain reachable, and older rows were created without them.
      info(`${email.padEnd(32)} has a test row; will fill any missing address/banking`)
      missing.push(target)
    } else {
      info(`${email.padEnd(32)} is a REAL BAM row (is_test=false) — left untouched`)
    }
  }

  if (missing.length === 0) {
    pass('nothing to do')
    return verdict('admin test accounts')
  }

  if (!APPLY) {
    console.log('')
    info(`dry run: ${missing.length} would be created. Re-run with --apply to write.`)
    return verdict('admin test accounts')
  }

  const results = []
  for (const m of missing) {
    const warning = await ensureTestBam(db, m)
    results.push({ email: m.email, warning })
  }

  // Read back from the DB rather than trusting the return value.
  const { data: after, error: aErr } = await db
    .from('bams').select('email, is_test, status, cohort_id, auth_user_id, street, city, prov, bank_name, account_no')
  if (aErr) { fail('read-back failed: ' + aErr.message); return verdict('admin test accounts') }

  console.log('')
  for (const m of missing) {
    const r = results.find(x => x.email === m.email)
    const row = (after || []).find(b => norm(b.email) === m.email)
    if (!row) {
      fail(`${m.email.padEnd(32)} NOT created. ${r && r.warning ? r.warning : 'no reason reported'}`)
    } else if (row.is_test !== true) {
      fail(`${m.email.padEnd(32)} created but is_test=${row.is_test} — it must be true`)
    } else if (row.auth_user_id !== m.userId) {
      fail(`${m.email.padEnd(32)} created but not linked to their login`)
    } else {
      pass(`${m.email.padEnd(32)} ready (status=${row.status}, is_test=true, ${row.street || 'NO STREET'} / ${row.bank_name || 'NO BANK'}, banking ${row.account_no ? 'set' : 'MISSING'})`)
      if (r && r.warning) info(`   note: ${r.warning}`)
    }
  }

  console.log('')
  info('these accounts carry obviously-fake test data (123 Test Street, TD 004) so an')
  info('admin can run an invoice end to end without walking onboarding first.')
  info('banking was written through encrypt_bam_banking and read back through')
  info('decrypt_bam_banking, so the invoice will not block on it.')
  verdict('admin test accounts')
}
main()
