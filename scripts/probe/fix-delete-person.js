/**
 * Removes one person completely: their roster row AND their login.
 *
 * WHY THIS REPLACES THE SQL VERSION
 * --------------------------------
 * `scripts/sql/delete-person.sql` deleted the `bams` row and then ran
 * `delete from auth.users`. On 2026-08-12 a row was deleted that way, re-added, invited,
 * and the student hit a dead end: onboarding said "A user with this email address has
 * already been registered". The login had survived. The SQL reported no error.
 *
 * A delete that cannot be confirmed is not a delete. This uses the Admin API, which was
 * verified to actually remove the user, and then READS BACK both the roster and the auth
 * list before saying it worked.
 *
 * WRITES. Dry run by default; pass --apply.
 *
 * REFUSES to touch anyone with receipts, invoices, ledger rows or warnings. Those are
 * accounting records; the right move for a real participant is status='archived'.
 *
 *   node scripts/probe/fix-delete-person.js someone@example.com
 *   node scripts/probe/fix-delete-person.js someone@example.com --apply
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

const APPLY = process.argv.includes('--apply')
const email = (process.argv.find(a => a.includes('@')) || '').trim().toLowerCase()

/** Tables whose rows mean this person has accounting history. */
const BLOCKERS = ['receipts', 'invoices', 'reimbursement_ledger', 'bam_warnings']

async function main() {
  if (!email) {
    fail('pass the email: node scripts/probe/fix-delete-person.js someone@example.com [--apply]')
    return verdict('delete person')
  }

  const db = serviceClient()

  const { data: bams, error: bErr } = await db
    .from('bams').select('id, email, first_name, last_name, status, is_test').ilike('email', email)
  if (bErr) { fail('bams read: ' + bErr.message); return verdict('delete person') }

  const { data: users, error: uErr } = await db.auth.admin.listUsers({ perPage: 1000 })
  if (uErr) { fail('listUsers: ' + uErr.message); return verdict('delete person') }
  const authUser = users.users.find(u => (u.email || '').trim().toLowerCase() === email)

  const bam = (bams || [])[0]
  info(`roster row: ${bam ? `${bam.first_name} ${bam.last_name} (${bam.status}, is_test=${bam.is_test})` : 'none'}`)
  info(`login:      ${authUser ? `exists, role=${(authUser.app_metadata || {}).role || 'none'}` : 'none'}`)

  if (!bam && !authUser) {
    pass('nothing to delete: neither a roster row nor a login exists for that address')
    return verdict('delete person')
  }

  // An admin's login is not ours to remove from here.
  const role = authUser ? (authUser.app_metadata || {}).role : null
  if (role === 'super_admin' || role === 'program_admin') {
    fail(`that login holds the ${role} role. Remove their admin access on /admin/team first, which also archives their test BAM row.`)
    return verdict('delete person')
  }

  // Accounting history means archive, not delete.
  if (bam) {
    let blocked = 0
    for (const t of BLOCKERS) {
      const { count, error } = await db.from(t).select('id', { count: 'exact', head: true }).eq('bam_id', bam.id)
      if (error) { fail(`${t} check failed: ${error.message}`); return verdict('delete person') }
      if (count && count > 0) {
        info(`  ${t}: ${count} row(s)`)
        blocked += count
      }
    }
    if (blocked > 0) {
      fail(
        `${email} has ${blocked} accounting row(s). Deleting them would silently change a month's ` +
        `totals. Archive instead:  update bams set status='archived' where id='${bam.id}';`
      )
      return verdict('delete person')
    }
  }

  if (!APPLY) {
    console.log('')
    info('dry run. Re-run with --apply to delete the roster row and the login.')
    return verdict('delete person')
  }

  console.log('')

  if (bam) {
    // Detach what only references the person, rather than deleting a question they asked.
    const { error: qErr } = await db.from('portal_questions').update({ bam_id: null }).eq('bam_id', bam.id)
    if (qErr) info(`portal_questions detach: ${qErr.message}`)
    const { error: oErr } = await db.from('onboarding_submissions').update({ matched_bam_id: null }).eq('matched_bam_id', bam.id)
    if (oErr) info(`onboarding_submissions detach: ${oErr.message}`)

    const { data: gone, error: dErr } = await db.from('bams').delete().eq('id', bam.id).select('id')
    if (dErr) { fail('roster delete failed: ' + dErr.message); return verdict('delete person') }
    if (!gone || gone.length !== 1) { fail('roster delete matched no rows'); return verdict('delete person') }
    pass('roster row deleted')
  }

  if (authUser) {
    // The Admin API, not `delete from auth.users`. The SQL version reported success
    // while leaving the login in place, which is what made a re-added BAM unable to
    // onboard at all.
    const { error: delErr } = await db.auth.admin.deleteUser(authUser.id)
    if (delErr) { fail('login delete failed: ' + delErr.message); return verdict('delete person') }
    pass('login deleted')
  }

  // Read back. This is the whole point: the previous version could not tell you whether
  // it had worked.
  const { data: afterBams } = await db.from('bams').select('id').ilike('email', email)
  const { data: afterUsers } = await db.auth.admin.listUsers({ perPage: 1000 })
  const stillAuth = (afterUsers?.users || []).some(u => (u.email || '').trim().toLowerCase() === email)

  console.log('')
  if ((afterBams || []).length > 0) fail(`a roster row for ${email} is STILL present`)
  else pass('roster: confirmed gone')

  if (stillAuth) fail(`the login for ${email} is STILL present. They will hit "already registered" if re-added.`)
  else pass('login: confirmed gone')

  verdict('delete person')
}
main()
