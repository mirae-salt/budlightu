/**
 * Q: Is this table actually empty?
 *
 * Ask BEFORE warning about the data in it. A migration was once flagged as
 * needing human review for possible duplicate rows; both tables had zero rows.
 *
 * Usage: node scripts/probe/row-counts.js [table ...]
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
    else pass(`${t.padEnd(24)} ${count} rows`)
  }
  verdict('row counts')
}
main()
