/**
 * Put a TEST invoice into the state a student would actually see, so the portal screen can be
 * tested without sending anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * Mirae, 2026-08-13: *"승인나야 학생이 invoice 보는 화면 테스트할 수 있어서 지금처럼 dry run이 살짝 곤란함."*
 *
 * Both halves are right and they pull against each other:
 *   - /portal/invoices shows "Being prepared" for a draft, with no View PDF and no Email me a
 *     copy. To test those, the invoice has to be past 'draft'.
 *   - A dryrun rehearsal deliberately LEAVES invoices as drafts, so the rehearsal stays
 *     repeatable through the same entry point. That was audit finding C2 and it should stay.
 *
 * The way out is not to weaken either one. It is to say plainly "this invoice is pretend-sent
 * so I can look at the student's screen", do it on test data only, and put it back.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It does NOT send anything, and it writes no invoice_sends row. The invoice will read as sent
 * without a matching send record, which is exactly what it is: a display state for testing.
 * Do not use it to mark a real invoice as handled.
 *
 * REFUSES outside a TEST cohort, and refuses if the BAM is not is_test. Both, not either: this
 * writes a money-document status, and the whole point of the guard is that it cannot be aimed
 * at a real student by accident.
 *
 * Usage:
 *   node scripts/probe/fix-test-invoice-status.js                 show what is there
 *   node scripts/probe/fix-test-invoice-status.js sent --apply    let the student see it
 *   node scripts/probe/fix-test-invoice-status.js draft --apply   put it back
 */
const { serviceClient, loadTs, pass, fail, info, verdict } = require('./_lib')

const ALLOWED = ['draft', 'sent', 'paid']

async function main() {
  const args = process.argv.slice(2)
  const target = args.find(a => !a.startsWith('--')) ?? null
  const apply = args.includes('--apply')

  if (target && !ALLOWED.includes(target)) {
    fail(`status must be one of ${ALLOWED.join(', ')}`)
    return verdict('test invoice status')
  }

  const db = serviceClient()
  const { isTestCohortName } = loadTs('lib/admin-test-bam.ts')

  const { data: invoices, error } = await db
    .from('invoices')
    .select('id, invoice_number, status, period, sent_at, pdf_key, bam_id, cohort_id, bams(email, is_test), cohorts(name)')
    .order('period', { ascending: false })

  if (error) {
    fail(`invoices unreadable: ${error.message}`)
    return verdict('test invoice status')
  }
  if (!(invoices ?? []).length) {
    info('no invoices exist yet. Generate one first.')
    return verdict('test invoice status')
  }

  const rel = (v) => (Array.isArray(v) ? v[0] : v)

  // Only ones this is allowed to touch.
  const eligible = []
  for (const inv of invoices) {
    const bam = rel(inv.bams)
    const cohort = rel(inv.cohorts)
    const testCohort = isTestCohortName(cohort?.name ?? null)
    const testBam = bam?.is_test === true
    const label = `${inv.invoice_number}  ${inv.period}  status=${String(inv.status).padEnd(6)} ${bam?.email ?? '?'}  cohort=${cohort?.name ?? '?'}`
    if (testCohort && testBam) {
      eligible.push(inv)
      info(`eligible   ${label}`)
    } else {
      info(`PROTECTED  ${label}  (${!testCohort ? 'live cohort' : 'not a test BAM'})`)
    }
  }

  if (!target) {
    info('')
    info('pass a status and --apply to change one, e.g. `sent --apply`')
    info("a draft shows the student 'Being prepared' with no View PDF and no Email me a copy")
    return verdict('test invoice status')
  }

  if (!eligible.length) {
    fail('nothing eligible: every invoice belongs to a live cohort or a real BAM')
    return verdict('test invoice status')
  }

  if (!apply) {
    info('')
    info(`DRY RUN. Would set ${eligible.length} invoice(s) to "${target}". Re-run with --apply.`)
    return verdict('test invoice status')
  }

  for (const inv of eligible) {
    // sent_at moves with the status so the record does not claim a send date for a draft, and
    // does not keep a stale one after being put back.
    const patch = target === 'draft'
      ? { status: 'draft', sent_at: null }
      : { status: target, sent_at: inv.sent_at ?? new Date().toISOString() }

    const { data: saved, error: updErr } = await db
      .from('invoices').update(patch).eq('id', inv.id).select('invoice_number, status, sent_at')

    if (updErr) { fail(`${inv.invoice_number}: ${updErr.message}`); continue }

    // Read back, because "the update returned no error" is not "the row says what I wanted".
    const row = (saved ?? [])[0]
    if (!row || row.status !== target) {
      fail(`${inv.invoice_number}: read back as "${row?.status ?? 'missing'}", expected "${target}"`)
      continue
    }
    pass(`${row.invoice_number} is now ${row.status}${row.sent_at ? ` (sent_at ${row.sent_at})` : ''}`)
  }

  info('')
  if (target === 'draft') {
    info('back to a draft. Batch approve will pick it up again.')
  } else {
    info('NOTHING WAS EMAILED and no invoice_sends row was written. This is a display state.')
    info('Sign in to the portal as that BAM to see View PDF and Email me a copy.')
    info('Put it back with: node scripts/probe/fix-test-invoice-status.js draft --apply')
  }
  verdict('test invoice status')
}
main()
