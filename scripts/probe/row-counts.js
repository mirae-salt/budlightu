/**
 * Q: Is this table actually empty?
 *
 * Ask BEFORE warning about the data in it. A migration was once flagged as
 * needing human review for possible duplicate rows; both tables had zero rows.
 *
 * Usage: node scripts/probe/row-counts.js [table ...]
 *
 * A head-count on a table that DOES NOT EXIST comes back `{count: null, error: null}`, so this
 * printed "PASS  bam_notifications null rows" for a table that had never been created. Same
 * fault nav-count-columns.js had and the same fix: a null count is not zero, it is no answer.
 */
const { serviceClient, pass, fail, verdict } = require('./_lib')

const DEFAULT = ['bams', 'cohorts', 'receipts', 'invoices', 'invoice_sends',
  'reimbursement_ledger', 'bam_warnings', 'admin_notifications', 'banks', 'audit_log']

async function main() {
  const db = serviceClient()
  const tables = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT
  for (const t of tables) {
    const { count, error } = await db.from(t).select('*', { count: 'exact', head: true })
    if (error) fail(`${t.padEnd(24)} unreadable: ${error.message}`)
    else if (count === null) fail(`${t.padEnd(24)} no count returned - the table probably does not exist`)
    else pass(`${t.padEnd(24)} ${count} rows`)
  }
  verdict('row counts')
}
main()
