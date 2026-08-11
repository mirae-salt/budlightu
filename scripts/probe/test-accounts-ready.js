/**
 * Q: Can each test account actually be invoiced, right now?
 *
 * "The fields are filled in" is not the same claim as "the invoice generates".
 * The invoice path HARD BLOCKS on several things independently, and each one fails
 * at a different layer, so filling a row in does not prove the chain works:
 *
 *   - incomplete mailing address        lib/invoice-payload.ts
 *   - province outside the tax table    computeHst() throws
 *   - banking that will not decrypt     generateInvoicePayload Edge Function
 *   - no invoice initials assigned      formatInvoiceNumber
 *   - cohort with no PO number          generateInvoicePayload Edge Function
 *
 * So this builds a real payload with the REAL builder for every test account and
 * reports what it produced. Read-only: generateInvoicePayload() in lib is pure, it
 * writes nothing, and no invoice row is created.
 *
 * Usage: node scripts/probe/test-accounts-ready.js
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const { generateInvoicePayload } = loadTs('lib/invoice-payload.ts')
if (typeof generateInvoicePayload !== 'function') {
  console.error('FAIL  could not load generateInvoicePayload from lib/invoice-payload.ts')
  process.exit(1)
}

const money = n => '$' + Number(n).toFixed(2)

async function main() {
  const db = serviceClient()

  const { data: bams, error: bErr } = await db
    .from('bams')
    .select('id, first_name, last_name, email, phone, street, city, prov, postal, ' +
            'bank_name, initials_resolved, is_test, status, cohort_id')
    .eq('is_test', true)
  if (bErr) { fail('bams read: ' + bErr.message); return verdict('test accounts invoice-ready') }
  if (!bams || bams.length === 0) {
    info('no test accounts exist')
    return verdict('test accounts invoice-ready')
  }

  const { data: cohorts, error: cErr } = await db
    .from('cohorts').select('id, name, po_number, salary_default, reimbursement_max, program_label, send_mode')
  if (cErr) { fail('cohorts read: ' + cErr.message); return verdict('test accounts invoice-ready') }

  for (const bam of bams) {
    const label = String(bam.email).padEnd(32)
    const cohort = (cohorts || []).find(c => c.id === bam.cohort_id)
    if (!cohort) { fail(label + 'cohort row missing'); continue }
    if (!cohort.po_number) { fail(label + 'cohort has no PO number — invoice would HARD BLOCK'); continue }

    // Banking is encrypted at rest. Decrypt through the RPC the Edge Function uses,
    // so a cleartext or wrong-key write fails here instead of at invoice time.
    // Only the PRESENCE of each field is reported; no value is ever printed.
    const { data: dec, error: dErr } = await db.rpc('decrypt_bam_banking', { p_bam_id: bam.id })
    if (dErr) { fail(label + 'decrypt_bam_banking failed: ' + dErr.message); continue }
    const banking = Array.isArray(dec) ? dec[0] : dec
    const missingBanking = ['institution_no', 'transit_no', 'account_no']
      .filter(k => !banking || !String(banking[k] ?? '').trim())
    if (missingBanking.length > 0) {
      fail(label + 'banking incomplete after decrypt (' + missingBanking.join(', ') + ') — invoice would HARD BLOCK')
      continue
    }

    // Institution number must agree with the bank name, or the deposit block names
    // one bank and routes the money to another.
    const { lookupBank } = loadTs('lib/banks.ts')
    const looked = bam.bank_name ? lookupBank(bam.bank_name) : null
    if (looked && looked.institutionNo !== banking.institution_no) {
      fail(`${label}bank_name "${bam.bank_name}" expects institution ${looked.institutionNo}, stored value differs`)
      continue
    }

    let payload
    try {
      payload = generateInvoicePayload({
        bam: {
          firstName: bam.first_name,
          lastName: bam.last_name,
          email: bam.email,
          phone: bam.phone,
          street: bam.street,
          city: bam.city,
          prov: bam.prov,
          postal: bam.postal,
          bankName: bam.bank_name,
          institutionNo: banking.institution_no,
          transitNo: banking.transit_no,
          accountNo: banking.account_no,
          hstNumber: banking.hst_number,
          initialsResolved: bam.initials_resolved
        },
        cohort: {
          programLabel: cohort.program_label,
          poNumber: cohort.po_number,
          salaryDefault: Number(cohort.salary_default),
          reimbursementMax: Number(cohort.reimbursement_max)
        },
        ledger: { paidCad: 150 },
        period: new Date(Date.UTC(2026, 8, 1)),
        seq: 1,
        generatedAt: new Date(Date.UTC(2026, 8, 16))
      })
    } catch (e) {
      fail(label + 'payload build threw: ' + (e && e.message ? e.message : String(e)))
      continue
    }

    pass(
      `${label}${payload.invoiceNumber.padEnd(12)} ` +
      `subtotal ${money(payload.subtotal)} tax ${money(payload.tax)} total ${money(payload.total)} ` +
      `(${payload.lines.length} lines, ${bam.prov}, send_mode=${cohort.send_mode})`
    )
  }

  console.log('')
  info('the payload builder is pure: nothing was written and no invoice row was created.')
  info('a PASS means the invoice would generate. It does not mean an email would send:')
  info('that depends on the cohort send_mode above and on approval.')
  verdict('test accounts invoice-ready')
}
main()
