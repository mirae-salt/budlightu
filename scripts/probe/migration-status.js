/**
 * Q: Which migrations are recorded in the live database's migration LEDGER?
 *
 * "0011 and 0013 are unapplied" was once stated from memory; the real answer was
 * eleven unapplied, not two. Ten seconds of checking would have caught it.
 *
 * Uses the CLI rather than PostgREST: `supabase_migrations` is not an exposed
 * schema, so a direct query always fails. A probe that always fails teaches you
 * to ignore probes.
 *
 * READ THE QUESTION CAREFULLY -- THIS IS THE LEDGER, NOT THE SCHEMA.
 * ----------------------------------------------------------------
 * `supabase migration list` reads supabase_migrations.schema_migrations. Applying
 * a migration by pasting it into the Supabase dashboard SQL editor creates the
 * objects WITHOUT writing that row, so the ledger says "pending" while the tables
 * and columns are already there.
 *
 * That is not hypothetical. Measured 2026-08-17: this probe reported 0025-0030
 * pending and printed "migrations must be applied BEFORE the code that reads the
 * new columns" -- but all ten objects those six migrations introduce
 * (student_reminders, portal_question_messages, bam_notifications,
 * portal_questions.answered_at/answered_by/answer, bams.wants_reminders,
 * bam_notifications.read, student_reminders.mode, cohorts.bam_copy_mode) existed
 * and the features were working. The old wording asserted a broken app that was
 * not broken, which is the failure mode this file's own header warns about.
 *
 * So: a PENDING row here means "not in the ledger". It does NOT mean the columns
 * are missing. For that question run schema-drift.js, which reads the real schema.
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

  if (pending.length === 0) pass(`all ${local.length} migrations recorded in the ledger`)
  else fail(`${pending.length} not recorded in the ledger:\n      ` + pending.join('\n      '))

  if (pending.length > 0) {
    // Say what was measured and what was NOT. The previous wording here claimed the
    // columns were missing, which was wrong the last time it fired -- see the header.
    info('this is the LEDGER, not the schema: these may already exist in the database')
    info('applying a migration via the dashboard SQL editor does not write a ledger row')
    info('to check whether the columns actually exist:  node scripts/probe/schema-drift.js')
    info('to reconcile the ledger without re-running SQL:  npx supabase migration repair --status applied <version>')
  }
  verdict('migration status (ledger)')
}
main()
