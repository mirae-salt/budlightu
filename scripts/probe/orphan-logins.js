/**
 * Logins with no roster row behind them.
 *
 * This is what `bams_left: 0, auth_left: 1` looks like: the roster row was deleted and the
 * login survived. It happens because `delete from auth.users` in SQL reports success without
 * deleting anything, which is the 2026-08-12 incident recorded in CLAUDE.md.
 *
 * Not every orphan is a mistake. Admins are not on the roster by design, so their logins are
 * SUPPOSED to be orphans, and deleting one would lock Robin or Nathan out of the whole app.
 * This separates the two and only names the ones that are safe to remove.
 */
const { serviceClient, loadEnv, pass, fail, info, verdict } = require('./_lib')

const ADMIN_ROLES = ['admin', 'super_admin', 'program_admin']

async function main() {
  loadEnv()
  const db = serviceClient()

  const { data: users, error: uErr } = await db.auth.admin.listUsers({ perPage: 1000 })
  if (uErr) { fail(`listUsers: ${uErr.message}`); return verdict('orphan logins') }

  const { data: bams, error: bErr } = await db.from('bams').select('email, status')
  if (bErr) { fail(`bams read: ${bErr.message}`); return verdict('orphan logins') }

  const onRoster = new Set(
    (bams || []).map(b => String(b.email || '').trim().toLowerCase()).filter(Boolean)
  )
  info(`logins: ${users.users.length}   roster rows: ${(bams || []).length}`)

  const orphans = []
  for (const u of users.users) {
    const email = String(u.email || '').trim().toLowerCase()
    if (!email) continue
    if (onRoster.has(email)) continue
    const role = (u.app_metadata || {}).role || (u.user_metadata || {}).role || null
    orphans.push({ email, role, id: u.id, created: u.created_at, lastSignIn: u.last_sign_in_at })
  }

  if (orphans.length === 0) {
    pass('every login has a roster row')
    return verdict('orphan logins')
  }

  const admins = orphans.filter(o => ADMIN_ROLES.includes(o.role))
  const removable = orphans.filter(o => !ADMIN_ROLES.includes(o.role))

  for (const o of admins) {
    info(`KEEP    ${o.email}  role=${o.role}  (admins are not on the roster on purpose)`)
  }

  for (const o of removable) {
    info(`ORPHAN  ${o.email}  role=${o.role || 'none'}  created=${o.created}  last sign in=${o.lastSignIn || 'never'}`)
  }

  if (removable.length === 0) {
    pass('the only logins without a roster row are admins, which is correct')
    return verdict('orphan logins')
  }

  // Not a fail: an orphan is a leftover, not a live defect. Nobody can sign in with one unless
  // they hold an admin role, because lib/signin-gate.ts requires a roster row.
  console.log('')
  info(`${removable.length} login(s) have no roster row. To remove one:`)
  for (const o of removable) {
    info(`  node scripts/probe/fix-delete-person.js ${o.email} --apply`)
  }
  info('That uses the Admin API, and reads back both lists afterward.')

  verdict('orphan logins')
}

main().catch(e => { fail(e.message); verdict('orphan logins') })
