/**
 * Q: For every account that exists, would the sign-in gate let them in?
 *
 * Robin (super_admin) and Nathan (program_admin) were both locked out of the app
 * entirely: the gate's only check was roster membership, and an administrator is not
 * necessarily on the BAM roster. It went unnoticed because the one admin who had
 * signed in also happened to have a roster row.
 *
 * Administrators keep being added, so this is a recurring class, not one incident.
 * Run it after adding an admin, after any roster change, and before a demo.
 *
 * READ-ONLY BY CONSTRUCTION. It evaluates the same function the route uses
 * (lib/signin-gate.ts) against data it reads, rather than calling
 * /api/auth/roster-check — that endpoint CREATES an auth user for a BAM who does not
 * have one yet, so probing it would write to production.
 *
 * Usage: node scripts/probe/can-sign-in.js
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const ADMIN_ROLES = ['super_admin', 'program_admin']

// The REAL rule, loaded from the app rather than reimplemented here. A probe that
// reimplements the rule agrees with itself instead of with the app.
const { signInDecision } = loadTs('lib/signin-gate.ts')
if (typeof signInDecision !== 'function') {
  console.error('FAIL  could not load signInDecision from lib/signin-gate.ts')
  process.exit(1)
}

async function main() {
  const db = serviceClient()

  const { data: users, error: uErr } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (uErr) { fail('listUsers: ' + uErr.message); return verdict('sign-in gate') }

  const { data: bams, error: bErr } = await db.from('bams').select('id, email, auth_user_id, status')
  if (bErr) { fail('bams read: ' + bErr.message); return verdict('sign-in gate') }

  const norm = e => String(e || '').trim().toLowerCase()

  // Every address that could plausibly try to sign in: every auth user, plus every
  // roster row, because a BAM can be rostered before their auth user exists.
  const emails = new Set()
  for (const u of users.users) if (u.email) emails.add(norm(u.email))
  for (const b of bams) if (b.email) emails.add(norm(b.email))
  const sorted = [...emails].sort()

  const rowsFor = email => bams
    .filter(b => norm(b.email) === email)
    .map(b => ({ id: b.id, auth_user_id: b.auth_user_id, status: b.status }))

  const roleFor = email => {
    const u = users.users.find(x => norm(x.email) === email)
    return (u && u.app_metadata && u.app_metadata.role) || '-'
  }

  const decisions = sorted.map(email => signInDecision({
    email,
    isExistingAdmin: ADMIN_ROLES.includes(roleFor(email)),
    bamRows: rowsFor(email)
  }))

  console.log('email'.padEnd(32), 'role'.padEnd(15), 'rostered', 'gate')
  console.log('-'.repeat(80))

  const adminsWithoutTestBam = []

  for (let i = 0; i < sorted.length; i++) {
    const email = sorted[i]
    const role = roleFor(email)
    const isAdmin = ADMIN_ROLES.includes(role)
    const rows = rowsFor(email)
    const d = decisions[i]

    const rostered = rows.length === 0 ? 'no ' : (rows.length > 1 ? 'DUP' : 'yes')
    const line = email.padEnd(32) + ' ' + String(role).padEnd(15) + ' ' + rostered + '      '

    if (d.allow) pass(line + 'ALLOW as ' + d.as)
    else if (isAdmin) fail(line + 'DENIED (' + d.reason + ') - an admin cannot sign in')
    else if (rows.length === 0) info(line + 'denied (not rostered) - expected for a non-participant')
    else fail(line + 'DENIED (' + d.reason + ') - a rostered BAM cannot sign in')

    // Signing in is not the whole job: an admin also has to be able to walk the
    // student journey to check what they are approving, and that needs a test BAM
    // row. Adding an admin now creates one; older admins may predate that.
    if (isAdmin && rows.length === 0) adminsWithoutTestBam.push(email)
  }

  console.log('')
  if (adminsWithoutTestBam.length > 0) {
    fail(`${adminsWithoutTestBam.length} admin(s) have no test BAM account, so the student portal shows them nothing: ${adminsWithoutTestBam.join(', ')}`)
    info('fix: node scripts/probe/fix-admin-test-bams.js --apply')
  } else {
    pass('every admin also has a BAM account, so they can test the student journey')
  }

  console.log('')
  info('evaluates lib/signin-gate.ts, the same function the route uses. No endpoint was called.')
  info('a PASS means the gate allows it, NOT that the OTP email arrives. Deliverability is separate.')
  verdict('sign-in gate')
}
main()
