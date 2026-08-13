/**
 * Q: Does every column the code SELECTs actually exist in the database?
 *
 * The type checker structurally cannot see this: column names live inside string
 * literals. Two real cases in this repo — a fraud gate queried `receipts.created_at`
 * (the column is `uploaded_at`) so it silently returned nothing forever, and a
 * dashboard queried `reimbursement_ledger.paid_cad` before that migration was
 * applied and rendered a confident empty chart.
 *
 * Heuristic by nature: it parses .select('a, b, c') calls. It errs toward
 * reporting something to look at rather than proving absence.
 */
const fs = require('fs')
const path = require('path')
const { ROOT, serviceClient, pass, fail, info, verdict } = require('./_lib')

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'scripts'])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out) }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(path.join(dir, e.name))
  }
  return out
}

async function main() {
  const db = serviceClient()
  const files = walk(ROOT)

  // .from('table')...select('col, col2')  — same statement, table before select
  const re = /\.from\(\s*['"`]([a-z_]+)['"`]\s*\)([\s\S]{0,400}?)\.select\(\s*['"`]([^'"`]+)['"`]/g
  const wanted = new Map()

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    let m
    while ((m = re.exec(src)) !== null) {
      const [, table, , cols] = m
      // Strip embedded relations before splitting. `bams(first_name, email)` is a
      // JOIN, and its inner names belong to `bams`, not to the outer table. A
      // naive comma split reports them as missing columns on the parent, and a
      // probe that cries wolf gets ignored.
      let flat = cols
      let prev
      do { prev = flat; flat = flat.replace(/[a-z_][a-z0-9_]*\s*\([^()]*\)/gi, '') } while (flat !== prev)

      for (let c of flat.split(',')) {
        c = c.trim()
        if (!c || c === '*' || c.includes('(') || c.includes(':')) continue   // skip leftovers/aliases
        if (!/^[a-z_][a-z0-9_]*$/.test(c)) continue
        const key = `${table}.${c}`
        if (!wanted.has(key)) wanted.set(key, path.relative(ROOT, f))
      }
    }
  }

  const byTable = new Map()
  for (const key of wanted.keys()) {
    const [t, c] = key.split('.')
    if (!byTable.has(t)) byTable.set(t, [])
    byTable.get(t).push(c)
  }

  info(`checking ${wanted.size} column references across ${byTable.size} tables`)
  let checked = 0
  let broken = 0
  for (const [table, cols] of byTable) {
    for (const col of cols) {
      const { error } = await db.from(table).select(col).limit(1)
      checked++
      if (error) {
        broken++
        fail(`${table}.${col} -> ${error.message}   (${wanted.get(`${table}.${col}`)})`)
      }
    }
  }
  // Counted, not assumed. This line used to print "N column references resolve" underneath a
  // list of failures, because it ran unconditionally: the verdict was right and the summary
  // directly above it contradicted it. A probe that argues with itself is one nobody reads.
  if (broken === 0) pass(`${checked} column references resolve against the live database`)
  else fail(`${broken} of ${checked} column references do NOT resolve`)
  info('does not cover columns built dynamically or inside RPC bodies')
  verdict('schema drift')
}
main()
