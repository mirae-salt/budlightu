/**
 * Q: Who can actually reach /admin right now?
 *
 * Answers it the way the CODE answers it: app_metadata.role only. The role used
 * to live in user_metadata, which a student can rewrite with the anon key, so a
 * probe that reads user_metadata would report the old, wrong answer.
 *
 * This exact question was asked three times in one session and answered by a
 * fresh throwaway script each time. Two admins turned out to be locked out.
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

const ADMIN_ROLES = ['super_admin', 'program_admin']

async function main() {
  const db = serviceClient()
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (error) { fail('listUsers: ' + error.message); return verdict('admin roles') }

  console.log('email'.padEnd(34), 'app_metadata'.padEnd(16), 'user_metadata (legacy, ignored)')
  console.log('-'.repeat(82))
  const stranded = []
  for (const u of data.users) {
    const app = (u.app_metadata && u.app_metadata.role) || '-'
    const legacy = (u.user_metadata && u.user_metadata.role) || '-'
    console.log(String(u.email).padEnd(34), String(app).padEnd(16), legacy)
    if (app === '-' && ADMIN_ROLES.includes(legacy)) stranded.push(u.email)
  }
  console.log('')

  const admins = data.users.filter(u => ADMIN_ROLES.includes(u.app_metadata && u.app_metadata.role))
  if (admins.length === 0) fail('NO admin has an app_metadata role. /admin is locked for everyone.')
  else pass(`${admins.length} admin(s): ${admins.map(a => a.email).join(', ')}`)

  if (stranded.length) fail(`stranded (role only in user_metadata, will be denied): ${stranded.join(', ')}`)
  else pass('nobody is stranded in user_metadata')

  info('after any role change the user must sign out and back in to mint a new JWT')
  verdict('admin roles')
}
main()
