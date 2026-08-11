/**
 * Realigns a TEST account's stored institution number with its bank name.
 *
 * Onboarding used to store whatever institution number the form submitted, checking
 * only that it was three digits. A row could therefore say "Wealthsimple" and carry
 * TD's 004, which would put one bank on the invoice PDF and route the deposit to
 * another. The write path is fixed; existing rows are not.
 *
 * WRITES. Dry run by default; pass --apply.
 *
 * TEST ROWS ONLY (`is_test = true`). A real BAM's banking is never rewritten here:
 * the correct route for a participant is a banking-change request, which an admin
 * reviews and which shows them the mismatch.
 *
 *   node scripts/probe/fix-test-bank-institution.js
 *   node scripts/probe/fix-test-bank-institution.js --apply
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const APPLY = process.argv.includes('--apply')
const { lookupBank } = loadTs('lib/banks.ts')

async function main() {
  const db = serviceClient()

  const { data: bams, error } = await db
    .from('bams').select('id, email, bank_name, is_test').eq('is_test', true)
  if (error) { fail('bams read: ' + error.message); return verdict('test bank institution') }

  const work = []
  for (const b of bams || []) {
    const label = String(b.email).padEnd(32)
    const bank = b.bank_name ? lookupBank(b.bank_name) : null
    if (!bank) { fail(`${label}bank_name "${b.bank_name}" is not in the lookup`); continue }

    const { data: dec, error: dErr } = await db.rpc('decrypt_bam_banking', { p_bam_id: b.id })
    if (dErr) { fail(`${label}decrypt failed: ${dErr.message}`); continue }
    const got = Array.isArray(dec) ? dec[0] : dec
    if (!got || !got.transit_no || !got.account_no) { info(`${label}no banking stored yet, skipping`); continue }

    if (got.institution_no === bank.institutionNo) {
      pass(`${label}institution matches ${b.bank_name}`)
    } else {
      // Prints institution numbers only. These are public per-bank codes, not
      // account data; transit and account numbers are never printed.
      info(`${label}${b.bank_name} expects ${bank.institutionNo}, stored ${got.institution_no}`)
      work.push({ id: b.id, email: b.email, want: bank.institutionNo, transit: got.transit_no, account: got.account_no, hst: got.hst_number ?? null })
    }
  }

  if (work.length === 0) { return verdict('test bank institution') }
  if (!APPLY) {
    console.log('')
    info(`dry run: ${work.length} would be realigned. Re-run with --apply.`)
    return verdict('test bank institution')
  }

  console.log('')
  for (const w of work) {
    // encrypt_bam_banking ignores a null argument, so transit/account/hst are passed
    // back unchanged rather than being wiped.
    const { error: encErr } = await db.rpc('encrypt_bam_banking', {
      p_bam_id: w.id,
      p_institution_no: w.want,
      p_transit_no: w.transit,
      p_account_no: w.account,
      p_hst_number: w.hst
    })
    if (encErr) { fail(`${String(w.email).padEnd(32)} write failed: ${encErr.message}`); continue }

    const { data: dec, error: dErr } = await db.rpc('decrypt_bam_banking', { p_bam_id: w.id })
    const got = Array.isArray(dec) ? dec[0] : dec
    if (dErr || !got) { fail(`${String(w.email).padEnd(32)} could not read back`); continue }
    if (got.institution_no !== w.want) {
      fail(`${String(w.email).padEnd(32)} still ${got.institution_no} after write`)
    } else if (got.transit_no !== w.transit || got.account_no !== w.account) {
      fail(`${String(w.email).padEnd(32)} institution fixed but transit/account changed — investigate`)
    } else {
      pass(`${String(w.email).padEnd(32)} institution now ${got.institution_no}, transit and account unchanged`)
    }
  }
  verdict('test bank institution')
}
main()
