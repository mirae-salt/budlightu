/**
 * Fills in EVERY test account (`bams.is_test = true`), not just an admin's.
 *
 * Test rows created before the profile seed existed have no address and no banking,
 * so the invoice chain HARD BLOCKS on them and nothing downstream can be tested.
 *
 * WRITES. Dry run by default; pass --apply.
 *
 * Only fills fields that are EMPTY, and only on rows flagged is_test. A real
 * student's record is never touched: seeding fake banking into a participant's row
 * would be a payment error, not a convenience.
 *
 *   node scripts/probe/fix-test-bam-profiles.js
 *   node scripts/probe/fix-test-bam-profiles.js --apply
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const APPLY = process.argv.includes('--apply')
const { fillTestBamProfile, TEST_BAM_PROFILE } = loadTs('lib/admin-test-bam.ts')
if (typeof fillTestBamProfile !== 'function') {
  console.error('FAIL  could not load fillTestBamProfile from lib/admin-test-bam.ts')
  process.exit(1)
}

async function main() {
  const db = serviceClient()

  const { data: bams, error } = await db
    .from('bams')
    .select('id, email, is_test, status, street, city, prov, postal, bank_name, institution_no')
    .eq('is_test', true)
  if (error) { fail('bams read: ' + error.message); return verdict('test account profiles') }
  if (!bams || bams.length === 0) { info('no test accounts exist'); return verdict('test account profiles') }

  const blank = v => v === null || v === undefined || String(v).trim() === ''
  const needs = bams.filter(b =>
    blank(b.street) || blank(b.city) || blank(b.prov) || blank(b.postal) ||
    blank(b.bank_name) || blank(b.institution_no)
  )

  for (const b of bams) {
    const gaps = ['street', 'city', 'prov', 'postal', 'bank_name', 'institution_no'].filter(k => blank(b[k]))
    if (gaps.length === 0) info(`${String(b.email).padEnd(32)} already complete`)
    else info(`${String(b.email).padEnd(32)} missing: ${gaps.join(', ')}`)
  }

  if (needs.length === 0) { pass('every test account is already filled in'); return verdict('test account profiles') }
  if (!APPLY) {
    console.log('')
    info(`dry run: ${needs.length} would be filled with ${TEST_BAM_PROFILE.street} / ${TEST_BAM_PROFILE.city}. Re-run with --apply.`)
    return verdict('test account profiles')
  }

  console.log('')
  for (const b of needs) {
    const warn = await fillTestBamProfile(db, b.id)
    if (warn) { fail(`${String(b.email).padEnd(32)} ${warn}`); continue }

    // Read back rather than trusting the return value.
    const { data: after, error: aErr } = await db
      .from('bams').select('street, city, prov, postal, bank_name, institution_no').eq('id', b.id)
    if (aErr || !after || after.length !== 1) { fail(`${String(b.email).padEnd(32)} could not read back`); continue }
    const row = after[0]
    const still = ['street', 'city', 'prov', 'postal', 'bank_name', 'institution_no'].filter(k => blank(row[k]))
    if (still.length > 0) fail(`${String(b.email).padEnd(32)} still missing after write: ${still.join(', ')}`)
    else pass(`${String(b.email).padEnd(32)} filled (${row.street}, ${row.city} ${row.prov}, ${row.bank_name})`)
  }

  console.log('')
  info('now run: node scripts/probe/test-accounts-ready.js')
  verdict('test account profiles')
}
main()
