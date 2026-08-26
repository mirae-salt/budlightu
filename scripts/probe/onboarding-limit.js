/**
 * Q: How many onboarding attempts does one network actually get, and how many are left?
 *
 * Ask BEFORE an onboarding day or a session where several people sign up together, and
 * ask again after changing any rate limit.
 *
 * This exists because on 2026-08-26 the answer was not the number anyone was looking at.
 * Three limits claimed to govern onboarding and they disagreed: middleware.ts said 100 a
 * day, supabase/functions/onboarding-ingest had 3 hardcoded, and the policy table had a
 * row called `onboarding_attempts_per_ip_per_day` that nothing reads. The hardcoded 3 is
 * the one that fired, so three BAMs went through in 34 seconds and the fourth person was
 * refused for 24 hours, hours after the visible limit had been raised.
 *
 * Read only. Usage: node scripts/probe/onboarding-limit.js
 */
const fs = require('fs')
const path = require('path')
const { ROOT, serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

async function main() {
  const db = serviceClient()

  // 1. The constant both fences are supposed to read.
  const { ONBOARDING_MAX_PER_IP_PER_DAY: LIMIT } = loadTs('lib/rate-limits.ts')
  if (typeof LIMIT !== 'number' || LIMIT <= 0) {
    fail(`lib/rate-limits.ts exports ONBOARDING_MAX_PER_IP_PER_DAY = ${String(LIMIT)}`)
    return verdict('onboarding limit')
  }
  pass(`lib/rate-limits.ts       ONBOARDING_MAX_PER_IP_PER_DAY = ${LIMIT}`)

  // 2. Do the two enforcement points actually reference it, or has one drifted back to
  //    a literal? Read as text: the middleware runs in its own runtime and the edge
  //    handler is imported by a route, so there is no single module to introspect.
  const sources = [
    ['middleware.ts', 'middleware.ts'],
    ['onboarding-ingest', 'supabase/functions/onboarding-ingest/index.ts']
  ]
  for (const [label, rel] of sources) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    if (text.includes('ONBOARDING_MAX_PER_IP_PER_DAY')) {
      pass(`${label.padEnd(24)} reads the shared constant`)
    } else {
      fail(`${label.padEnd(24)} does NOT read the shared constant - it has its own number again`)
    }
  }

  // 3. The policy row that looks like the control and is not one.
  const { data: pol, error: polErr } = await db.from('policy')
    .select('value_json').eq('key', 'onboarding_attempts_per_ip_per_day').limit(1)
  if (polErr) {
    info(`policy row unreadable: ${polErr.message}`)
  } else if ((pol ?? []).length) {
    info(`policy.onboarding_attempts_per_ip_per_day = ${JSON.stringify(pol[0].value_json)} and is READ BY NOTHING. Changing it has no effect.`)
  }

  // 4. What today's counter actually holds. This is the durable one that decides.
  const today = new Date().toISOString().slice(0, 10)
  const { data: hits, error: hitErr } = await db.from('audit_log')
    .select('entity_id, ts')
    .eq('entity', 'onboarding_ratelimit_ip')
    .gte('ts', `${today}T00:00:00Z`)
    .order('ts')
  if (hitErr) {
    fail(`attempt counter unreadable: ${hitErr.message}`)
    return verdict('onboarding limit')
  }

  const byIp = new Map()
  for (const h of hits ?? []) byIp.set(h.entity_id, (byIp.get(h.entity_id) ?? 0) + 1)

  if (byIp.size === 0) {
    pass(`no onboarding attempts logged today - every network has all ${LIMIT}`)
  } else {
    for (const [ip, n] of byIp) {
      const left = LIMIT - n
      const line = `network ${String(ip).slice(0, 12)}  ${n} used, ${left} left today`
      if (left <= 0) fail(`${line}  <== the next person on this network is refused`)
      else if (left <= 5) fail(`${line}  <== nearly out`)
      else pass(line)
    }
  }

  info('the invite token is the real gate: onboarding needs a valid hash on a row still marked pending, and completing it flips that status')
  verdict('onboarding limit')
}
main()
