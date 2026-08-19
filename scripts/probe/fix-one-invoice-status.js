/**
 * Change the status of ONE named invoice. Test data only.
 *
 * WHY THIS EXISTS ALONGSIDE fix-test-invoice-status.js
 * ----------------------------------------------------
 * That script loops over every eligible invoice: `for (const inv of eligible)`. That is
 * right for its job (put the student's screen into a state so it can be looked at) and
 * wrong for this one. Before a real AP send you want EXACTLY ONE invoice in `draft`,
 * because `batch-approve` selects on `.eq('status','draft')` — so the number of drafts
 * is the number of emails that leave. Flipping all five to draft to send one would put
 * five real invoices in front of accounts payable.
 *
 * Takes an invoice number, refuses if it does not match exactly one row, and refuses
 * outside a TEST cohort or on a BAM that is not `is_test` — both, not either. Reads the
 * row back after writing, because "the update returned no error" is not "the row says
 * what I wanted".
 *
 * Sends nothing. Writes no invoice_sends row.
 *
 * Usage:
 *   node scripts/probe/fix-one-invoice-status.js INV-ML1                 show it
 *   node scripts/probe/fix-one-invoice-status.js INV-ML1 draft --apply   change it
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */
const { serviceClient, loadTs, pass, fail, info, verdict } = require('./_lib')

const ALLOWED = ['draft', 'sent', 'paid']

async function main() {
  const args = process.argv.slice(2)
  const positional = args.filter(a => !a.startsWith('--'))
  const number = positional[0] ?? null
  const target = positional[1] ?? null
  const apply = args.includes('--apply')

  if (!number) {
    fail('give an invoice number, e.g. `INV-ML1`')
    return verdict('one invoice status')
  }
  if (target && !ALLOWED.includes(target)) {
    fail(`status must be one of ${ALLOWED.join(', ')}`)
    return verdict('one invoice status')
  }

  const db = serviceClient()
  const { isTestCohortName } = loadTs('lib/admin-test-bam.ts')

  const { data: rows, error } = await db
    .from('invoices')
    .select('id, invoice_number, status, period, sent_at, pdf_key, bams(email, is_test), cohorts(name)')
    .eq('invoice_number', number)

  if (error) { fail(`unreadable: ${error.message}`); return verdict('one invoice status') }
  if (!(rows ?? []).length) { fail(`no invoice numbered ${number}`); return verdict('one invoice status') }
  if (rows.length > 1) {
    // Refuse rather than guess. Two rows with one number is itself a finding.
    fail(`${rows.length} invoices share the number ${number} — refusing to touch any of them`)
    return verdict('one invoice status')
  }

  const inv = rows[0]
  const rel = v => (Array.isArray(v) ? v[0] : v)
  const bam = rel(inv.bams)
  const cohort = rel(inv.cohorts)
  const testCohort = isTestCohortName(cohort?.name ?? null)
  const testBam = bam?.is_test === true

  info(`${inv.invoice_number}  ${inv.period}  status=${inv.status}  pdf=${inv.pdf_key ? 'yes' : 'NO'}`)
  info(`  bam ${bam?.email ?? '?'} (is_test=${testBam})   cohort ${cohort?.name ?? '?'} (test=${testCohort})`)

  if (!testCohort || !testBam) {
    fail(`PROTECTED: ${!testCohort ? 'not a TEST cohort' : 'BAM is not is_test'} — refusing`)
    return verdict('one invoice status')
  }
  if (!inv.pdf_key && target !== 'draft') {
    info('note: no pdf_key, so an AP send would be refused with "pdf not rendered yet"')
  }

  if (!target) {
    info('')
    info(`pass a status and --apply, e.g. \`${number} draft --apply\``)
    return verdict('one invoice status')
  }
  if (inv.status === target) {
    pass(`already ${target}. Nothing to do.`)
    return verdict('one invoice status')
  }
  if (!apply) {
    info('')
    info(`DRY RUN. Would change ${inv.invoice_number} from "${inv.status}" to "${target}". Re-run with --apply.`)
    info(`Revert with: node scripts/probe/fix-one-invoice-status.js ${number} ${inv.status} --apply`)
    return verdict('one invoice status')
  }

  const patch = target === 'draft'
    ? { status: 'draft', sent_at: null }
    : { status: target, sent_at: inv.sent_at ?? new Date().toISOString() }

  const { data: saved, error: updErr } = await db
    .from('invoices').update(patch).eq('id', inv.id)
    .select('invoice_number, status, sent_at')

  if (updErr) { fail(`${inv.invoice_number}: ${updErr.message}`); return verdict('one invoice status') }

  const row = (saved ?? [])[0]
  if (!row || row.status !== target) {
    fail(`read back as "${row?.status ?? 'missing'}", expected "${target}"`)
    return verdict('one invoice status')
  }
  pass(`${row.invoice_number} is now ${row.status}${row.sent_at ? ` (sent_at ${row.sent_at})` : ' (sent_at cleared)'}`)

  // The number of drafts is the number of emails a batch approve would send. Say it.
  const { data: drafts } = await db
    .from('invoices').select('invoice_number').eq('status', 'draft')
  info('')
  info(`invoices now in draft: ${(drafts ?? []).length} — ${(drafts ?? []).map(d => d.invoice_number).join(', ') || 'none'}`)
  info('a batch approve would send exactly that many AP emails')

  verdict('one invoice status')
}
main()
