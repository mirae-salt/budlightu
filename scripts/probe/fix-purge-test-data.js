/**
 * Delete everything the test accounts produced, leaving the accounts themselves.
 *
 * WHY
 * ---
 * Mirae, 2026-08-13: "보낸척 굳이 되돌릴 필요 없고 나중에 test 끝나면 싹다 밀면될듯." Right. Undoing
 * each test one at a time is fiddly and easy to half-finish; wiping once at the end is one
 * decision made once. This is that wipe, and it is also the GO-LIVE step that makes September
 * start from nothing.
 *
 * WHAT IT DELETES
 * ---------------
 * Rows belonging to `is_test` BAMs, in dependency order:
 *   invoice_sends, invoices, reimbursement_ledger, receipts, bam_warnings,
 *   bam_notifications, student_reminders, portal_question_messages, portal_questions,
 *   admin_notifications about those BAMs (plus orphans with no bam_id)
 *
 * WHAT IT KEEPS, deliberately
 * ---------------------------
 *   bams, cohorts     the accounts stay, so testing can start again tomorrow
 *   audit_log         it is the record that these things happened, including this purge.
 *                     Deleting an audit trail to tidy up is the one cleanup nobody should
 *                     automate. Pass --audit to include it if you really mean to.
 *   storage objects   invoice PDFs in the `invoices` bucket. Deleting them needs the storage
 *                     API rather than a table delete; they are listed at the end so they are
 *                     not forgotten, and they are harmless (nothing links to a deleted invoice).
 *
 * REFUSES to touch anything owned by a BAM that is not `is_test`. Every delete is scoped by an
 * id list built from that check, never by "everything in the table".
 *
 * Usage:
 *   node scripts/probe/fix-purge-test-data.js            count what would go
 *   node scripts/probe/fix-purge-test-data.js --apply    delete it
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

/** Child tables first: invoice_sends references invoices, messages reference questions. */
const BY_BAM = [
  { table: 'invoice_sends', via: 'invoice_id' },
  { table: 'invoices', via: 'bam_id' },
  { table: 'reimbursement_ledger', via: 'bam_id' },
  { table: 'receipts', via: 'bam_id' },
  { table: 'bam_warnings', via: 'bam_id' },
  { table: 'bam_notifications', via: 'bam_id' },
  { table: 'student_reminders', via: 'bam_id' },
  { table: 'portal_question_messages', via: 'question_id' },
  { table: 'portal_questions', via: 'bam_id' }
]

async function main() {
  const apply = process.argv.includes('--apply')
  const includeAudit = process.argv.includes('--audit')
  const db = serviceClient()

  const { data: bams, error } = await db.from('bams').select('id, email, is_test')
  if (error) { fail(`bams unreadable: ${error.message}`); return verdict('purge test data') }

  const testIds = (bams ?? []).filter(b => b.is_test === true).map(b => b.id)
  const realCount = (bams ?? []).length - testIds.length

  if (!testIds.length) { fail('no is_test accounts found, so there is nothing this may touch'); return verdict('purge test data') }
  info(`${testIds.length} test account(s); ${realCount} real account(s) will not be touched`)

  // Ids of the parents, so the child tables can be scoped without a join.
  const invoiceIds = ((await db.from('invoices').select('id').in('bam_id', testIds)).data ?? []).map(r => r.id)
  const questionIds = ((await db.from('portal_questions').select('id').in('bam_id', testIds)).data ?? []).map(r => r.id)

  const idsFor = (via) =>
    via === 'invoice_id' ? invoiceIds : via === 'question_id' ? questionIds : testIds

  let total = 0
  for (const { table, via } of BY_BAM) {
    const ids = idsFor(via)
    if (!ids.length) { info(`${table.padEnd(26)} 0`); continue }

    if (!apply) {
      const { count, error: cErr } = await db.from(table).select('*', { count: 'exact', head: true }).in(via, ids)
      if (cErr) { fail(`${table}: ${cErr.message}`); continue }
      if (count === null) { fail(`${table}: no count returned, the table may not exist`); continue }
      info(`${table.padEnd(26)} ${count}`)
      total += count
      continue
    }

    const { data, error: dErr } = await db.from(table).delete().in(via, ids).select('id')
    if (dErr) { fail(`${table}: ${dErr.message}`); continue }
    const n = (data ?? []).length
    total += n
    pass(`${table.padEnd(26)} deleted ${n}`)
  }

  // Admin notifications about these BAMs, plus orphans with no bam_id (left over from the old
  // dev-bypass path that inserted questions with a null bam_id).
  {
    const t = 'admin_notifications'
    if (!apply) {
      const { count } = await db.from(t).select('*', { count: 'exact', head: true }).in('bam_id', testIds)
      const { count: orphans } = await db.from(t).select('*', { count: 'exact', head: true }).is('bam_id', null)
      info(`${t.padEnd(26)} ${(count ?? 0) + (orphans ?? 0)}  (${count ?? 0} for test BAMs, ${orphans ?? 0} orphaned)`)
      total += (count ?? 0) + (orphans ?? 0)
    } else {
      const a = await db.from(t).delete().in('bam_id', testIds).select('id')
      const b = await db.from(t).delete().is('bam_id', null).select('id')
      if (a.error || b.error) fail(`${t}: ${a.error?.message ?? b.error?.message}`)
      else {
        const n = (a.data ?? []).length + (b.data ?? []).length
        total += n
        pass(`${t.padEnd(26)} deleted ${n}`)
      }
    }
  }

  if (includeAudit) {
    if (!apply) {
      const { count } = await db.from('audit_log').select('*', { count: 'exact', head: true })
      info(`audit_log                  ${count}  (--audit given, so this WOULD go too)`)
    } else {
      const { data, error: aErr } = await db.from('audit_log').delete().neq('id', '00000000-0000-0000-0000-000000000000').select('id')
      if (aErr) fail(`audit_log: ${aErr.message}`)
      else pass(`audit_log                  deleted ${(data ?? []).length}`)
    }
  } else {
    info('audit_log                  KEPT (pass --audit to include it)')
  }

  if (!apply) {
    info('')
    info(`DRY RUN. ${total} row(s) would be deleted. Re-run with --apply.`)
    return verdict('purge test data')
  }

  // Read back, because a delete that removed nothing reports no error.
  info('')
  let leftovers = 0
  for (const { table, via } of BY_BAM) {
    const ids = idsFor(via)
    if (!ids.length) continue
    const { count } = await db.from(table).select('*', { count: 'exact', head: true }).in(via, ids)
    if (count) { fail(`${table} still has ${count} row(s)`); leftovers += count }
  }
  if (!leftovers) pass(`clean: ${total} row(s) deleted and nothing belonging to a test account remains`)

  // The PDFs, which live in storage and are not a table.
  const objs = await db.storage.from('invoices').list('', { limit: 100 })
  if (!objs.error) {
    const folders = (objs.data ?? []).map(o => o.name)
    if (folders.length) {
      info('')
      info(`invoice PDFs still in storage (harmless, delete by hand if you want): ${folders.join(', ')}`)
    }
  }

  info('accounts and cohorts were not touched. Re-seed with fix-seed-test-invoices.js.')
  verdict('purge test data')
}
main()
