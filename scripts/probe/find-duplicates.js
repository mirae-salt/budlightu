/**
 * Q: Will a unique constraint build, or will it fail on existing data?
 *
 * Usage: node scripts/probe/find-duplicates.js <table> <col1,col2,...>
 *   e.g. node scripts/probe/find-duplicates.js invoices cohort_id,invoice_number
 */
const { serviceClient, pass, fail, verdict } = require('./_lib')

async function main() {
  const [table, colsArg] = process.argv.slice(2)
  if (!table || !colsArg) {
    console.error('usage: node scripts/probe/find-duplicates.js <table> <col1,col2,...>')
    process.exit(2)
  }
  const cols = colsArg.split(',').map(s => s.trim())
  const db = serviceClient()
  const { data, error } = await db.from(table).select(cols.join(','))
  if (error) { fail(`${table} unreadable: ${error.message}`); return verdict('duplicates') }

  const seen = new Map()
  const dupes = new Set()
  for (const row of data ?? []) {
    const k = cols.map(c => String(row[c])).join(' | ')
    if (seen.has(k)) dupes.add(k); else seen.set(k, true)
  }
  if (dupes.size === 0) pass(`${table}(${cols.join(',')}): ${(data ?? []).length} rows, no duplicates. Unique index will build.`)
  else fail(`${table}(${cols.join(',')}): BLOCKS the unique index:\n      ` + [...dupes].join('\n      '))
  verdict('duplicates')
}
main()
