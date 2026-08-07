/**
 * Q: Which migrations are applied to the live database?
 *
 * "0011 and 0013 are unapplied" was once stated from memory; the real answer was
 * eleven unapplied, not two. Ten seconds of checking would have caught it.
 *
 * Uses the CLI rather than PostgREST: `supabase_migrations` is not an exposed
 * schema, so a direct query always fails. A probe that always fails teaches you
 * to ignore probes.
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { ROOT, pass, fail, info, verdict } = require('./_lib')

async function main() {
  const dir = path.join(ROOT, 'supabase', 'migrations')
  const local = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

  let out
  try {
    out = execSync('npx supabase migration list', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    fail('supabase migration list failed: ' + (e.stderr || e.message).toString().slice(0, 300))
    return verdict('migration status')
  }

  // Rows look like:  "   0016 │   0016 │       0016"  (LOCAL | REMOTE | TIME)
  // A remote column that is blank means the migration is not applied.
  const applied = new Set()
  const seenLocal = new Set()
  for (const line of out.split('\n')) {
    const clean = line.replace(/\[[0-9;]*m/g, '')
    const m = clean.match(/^\s*(\d{4})\s*│\s*(\d{4})?\s*│/)
    if (!m) continue
    seenLocal.add(m[1])
    if (m[2]) applied.add(m[2])
  }

  if (seenLocal.size === 0) {
    fail('could not parse the CLI table; run `npx supabase migration list` by hand')
    return verdict('migration status')
  }

  const pending = []
  for (const f of local) {
    const v = f.split('_')[0]
    const isApplied = applied.has(v)
    if (!isApplied) pending.push(f)
    console.log(`  ${isApplied ? 'applied ' : 'PENDING '} ${f}`)
  }
  console.log('')

  if (pending.length === 0) pass(`all ${local.length} migrations applied`)
  else fail(`${pending.length} pending:\n      ` + pending.join('\n      '))

  info('migrations must be applied BEFORE the code that reads the new columns')
  verdict('migration status')
}
main()
