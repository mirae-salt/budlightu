/**
 * Give every TEST account an invoice, so each admin can log into their own portal and see the
 * student view.
 *
 * WHY
 * ---
 * Mirae, 2026-08-13: "robin도 테스트할텐데 그럼 어케?" Robin cannot run node scripts, and more to
 * the point she had nothing to look at: only one test account had an invoice, so signing in as
 * her own test BAM showed an empty page. Testing "what does a student see" needs every tester
 * to have something to see.
 *
 * Generates through upsertDraftInvoice, the SAME function the monthly run uses, so what appears
 * is a real invoice and not a fixture. Then marks them 'sent', because /portal/invoices hides
 * View PDF and Email me a copy on a draft.
 *
 * NOTHING IS EMAILED and no invoice_sends row is written. 'sent' here is a display state. See
 * fix-test-invoice-status.js, which this reuses the reasoning of.
 *
 * TEST COHORT AND is_test ONLY, both. It writes invoice rows, so it must not be aimable at a
 * real student by accident.
 *
 * Usage:
 *   node scripts/probe/fix-seed-test-invoices.js                     show what would happen
 *   node scripts/probe/fix-seed-test-invoices.js --apply             generate and mark sent
 *   node scripts/probe/fix-seed-test-invoices.js --apply --draft     generate, leave as drafts
 *   node scripts/probe/fix-seed-test-invoices.js --period 2026-09-01 pick the month
 */
const { serviceClient, loadTs, pass, fail, info, verdict } = require('./_lib')

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main() {
  const apply = process.argv.includes('--apply')
  const leaveDraft = process.argv.includes('--draft')

  const db = serviceClient()
  const { isTestCohortName } = loadTs('lib/admin-test-bam.ts')
  const { upsertDraftInvoice } = loadTs('lib/draft-invoice.ts')

  // Default to the month an invoice already exists for, so this does not quietly invent a new
  // period; otherwise the first of the current month.
  const existing = (await db.from('invoices').select('period').order('period', { ascending: false }).limit(1)).data
  const fallbackPeriod = existing && existing.length
    ? existing[0].period
    : new Date().toISOString().slice(0, 8) + '01'
  const period = argValue('--period', fallbackPeriod)
  info(`period ${period}`)

  const { data: bams, error } = await db
    .from('bams')
    .select('id, email, is_test, status, cohort_id, cohorts(name)')
    .eq('status', 'active')
    .order('email')
  if (error) { fail(`bams unreadable: ${error.message}`); return verdict('seed test invoices') }

  const targets = []
  for (const b of bams ?? []) {
    const cohort = Array.isArray(b.cohorts) ? b.cohorts[0] : b.cohorts
    if (b.is_test === true && isTestCohortName(cohort?.name ?? null)) targets.push(b)
    else info(`skipping ${b.email} (${b.is_test ? 'not a TEST cohort' : 'not a test account'})`)
  }

  if (!targets.length) { fail('no eligible test accounts'); return verdict('seed test invoices') }

  if (!apply) {
    for (const b of targets) info(`would generate for ${b.email}`)
    info('')
    info('DRY RUN. Re-run with --apply.')
    return verdict('seed test invoices')
  }

  for (const b of targets) {
    // Already in a state the portal shows? Then this account is ready and there is nothing to
    // do. Checked BEFORE generating, because upsertDraftInvoice correctly refuses to rewrite a
    // sent document and that refusal is not a failure of this script. Reporting it as one
    // teaches people that a red verdict here means nothing, which is how a real failure gets
    // waved through later.
    const { data: already } = await db
      .from('invoices')
      .select('invoice_number, status')
      .eq('bam_id', b.id)
      .eq('period', period)
      .neq('status', 'draft')
      .limit(1)
    const ready = (already ?? [])[0]
    if (ready && !leaveDraft) {
      pass(`${b.email}  ${ready.invoice_number}  ${ready.status}  (already ready, left alone)`)
      continue
    }

    const res = await upsertDraftInvoice(db, b.id, b.cohort_id, period)
    if (!res.ok) {
      // A genuine block: usually a missing address or undecryptable banking. Worth seeing
      // rather than skipping, because it is the same block a real student would hit.
      fail(`${b.email}: ${res.reason}`)
      continue
    }

    if (leaveDraft) {
      pass(`${b.email}  ${res.invoiceNumber}  draft  (reimbursement $${res.reimbursementCad})`)
      continue
    }

    const { data: saved, error: updErr } = await db
      .from('invoices')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', res.invoiceId)
      .select('invoice_number, status')
    if (updErr) { fail(`${b.email}: generated ${res.invoiceNumber} but could not mark it sent: ${updErr.message}`); continue }

    const row = (saved ?? [])[0]
    if (!row || row.status !== 'sent') {
      fail(`${b.email}: ${res.invoiceNumber} read back as "${row?.status ?? 'missing'}"`)
      continue
    }
    pass(`${b.email}  ${row.invoice_number}  sent  (reimbursement $${res.reimbursementCad})`)
  }

  // Read back the whole picture rather than trusting the loop above.
  const after = (await db.from('invoices').select('invoice_number, status, bam_id, period').eq('period', period)).data ?? []
  info('')
  info(`${after.length} invoice(s) now exist for ${period}`)
  if (!leaveDraft) {
    info('NOTHING WAS EMAILED. "sent" is a display state so the portal shows View PDF.')
    info('Each tester signs in at /portal/login with their own address.')
    info('Clean up afterwards with: node scripts/probe/fix-purge-test-data.js --apply')
  }
  verdict('seed test invoices')
}
main()
