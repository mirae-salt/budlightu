/**
 * Q: Does the banks table match lib/banks.ts, and is anything defunct?
 *
 * Nine institution numbers were corrected by an UPDATE that matched zero rows and
 * reported success, because the rows had never existed in this environment. Only
 * reading the table back caught it.
 */
const { execSync } = require('child_process')
const { ROOT, serviceClient, pass, fail, info, verdict } = require('./_lib')

// Institutions that no longer clear. A dead code is worse than a missing one: it
// passes every format check and routes into a closed lane, whereas an unlisted
// bank hard-fails to a human.
const DEFUNCT = { '016': 'HSBC Canada (RBC 2024-03)', '030': 'Canadian Western (National 2025-03)', '374': 'motusbank (Meridian)' }

async function main() {
  const out = execSync('npx tsx -e "import {BANK_SEED} from \'./lib/banks\'; console.log(JSON.stringify(BANK_SEED))"',
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const seed = JSON.parse(out.trim().split('\n').pop())

  const db = serviceClient()
  const { data: rows, error } = await db.from('banks').select('name_normalized, institution_no')
  if (error) { fail('banks unreadable: ' + error.message); return verdict('bank codes') }

  const inDb = Object.fromEntries(rows.map(r => [r.name_normalized, r.institution_no]))
  let bad = 0
  for (const b of seed) {
    if (inDb[b.normalized] !== b.institutionNo) {
      fail(`${b.normalized}: code has ${b.institutionNo}, db has ${inDb[b.normalized] ?? '(missing)'}`)
      bad++
    }
  }
  if (bad === 0) pass(`all ${seed.length} entries match lib/banks.ts`)

  for (const [code, name] of Object.entries(DEFUNCT)) {
    const hit = rows.filter(r => r.institution_no === code)
    if (hit.length) fail(`defunct ${code} ${name} still present: ${hit.map(h => h.name_normalized).join(', ')}`)
  }
  if (!Object.keys(DEFUNCT).some(c => rows.some(r => r.institution_no === c))) pass('no defunct institutions')

  info('lookups run off lib/banks.ts, not this table; the table is kept in sync so it cannot be mistaken for the source of truth')
  verdict('bank codes')
}
main()
