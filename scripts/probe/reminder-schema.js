/**
 * What columns exist for recording that a student was reminded?
 *
 * A reminder that cannot record itself sends every day the cron runs. Before writing one,
 * find out what row already exists to hang it on, rather than guessing a table name again.
 */
const { serviceClient, loadEnv, info, verdict } = require('./_lib')

async function main() {
  loadEnv()
  const db = serviceClient()
  for (const t of ['bam_warnings', 'warnings', 'receipts', 'bams', 'reimbursement_ledger']) {
    const { data, error } = await db.from(t).select('*').limit(1)
    if (error) { info(`${t}: ERR ${error.message}`); continue }
    info(`${t}: ${data[0] ? Object.keys(data[0]).join(',') : '(empty table)'}`)
  }
  verdict()
}

main().catch(e => { info(`threw: ${e.message}`); verdict() })
