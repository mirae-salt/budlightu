/**
 * Q: Is the code I just pushed actually running in production?
 *
 * WHY THIS EXISTS
 * ---------------
 * 2026-08-13: a fix was pushed, "it still fails" came back, and working out whether the deploy
 * even had the fix took four probes and ended in an inference. Half an hour went into a
 * question that should cost one request. "Is it deployed" is the first thing to rule out when
 * a fix does not appear to work, and it was the one thing nothing could answer.
 *
 * Compares `git rev-parse HEAD` against /api/version on the live site.
 *
 * Usage: node scripts/probe/deployed-version.js [url]
 *        defaults to NEXT_PUBLIC_APP_URL from .env.local
 */
const { execSync } = require('child_process')
const { ROOT, loadEnv, pass, fail, info, verdict } = require('./_lib')

async function main() {
  loadEnv()
  const base = (process.argv[2] || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
  if (!base) {
    fail('no URL: pass one, or set NEXT_PUBLIC_APP_URL in .env.local')
    return verdict('deployed version')
  }

  let localSha = null
  let localSubject = ''
  try {
    localSha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
    localSubject = execSync('git log -1 --pretty=%s', { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch (e) {
    fail(`could not read local HEAD: ${e.message}`)
    return verdict('deployed version')
  }
  info(`local  HEAD  ${localSha.slice(0, 7)}  ${localSubject}`)

  // Read the body as TEXT first and only then try to parse it. A build that predates
  // /api/version answers with Next's 404 HTML page, and `await res.json()` on that throws
  // "Unexpected token '<'", which this probe reported as "could not reach the site". That is a
  // wrong answer to the exact question it was written to settle: the site was reachable and
  // the route was missing, which is itself the finding.
  let res, raw
  try {
    res = await fetch(`${base}/api/version`, { headers: { 'Cache-Control': 'no-cache' } })
    raw = await res.text()
  } catch (e) {
    fail(`could not reach ${base}/api/version: ${e.message}`)
    return verdict('deployed version')
  }
  let body = null
  try { body = JSON.parse(raw) } catch { /* handled below */ }

  if (res.status === 404) {
    fail(`${base} has no /api/version yet, so it is running a build from before this probe existed`)
    info('that is itself the answer: the deploy is older than 2026-08-13')
    return verdict('deployed version')
  }
  if (!body) {
    fail(`${base}/api/version returned ${res.status} and did not return JSON`)
    info(`first bytes: ${JSON.stringify(raw.slice(0, 80))}`)
    info('an HTML page here means the route is not in the deployed build yet')
    return verdict('deployed version')
  }
  if (!res.ok || body.ok !== true) {
    fail(`/api/version returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
    return verdict('deployed version')
  }

  if (body.local) {
    info('the target reports it is NOT a Vercel build (local dev server)')
    return verdict('deployed version')
  }

  info(`remote build  ${body.commitShort}  branch=${body.branch} env=${body.env}`)

  if (body.commit === localSha) {
    pass('production is running exactly this commit')
  } else {
    fail(`production is running ${body.commitShort}, local HEAD is ${localSha.slice(0, 7)}`)
    // Which direction, because "behind" and "ahead of" need different reactions.
    try {
      execSync(`git cat-file -e ${body.commit}^{commit}`, { cwd: ROOT, stdio: 'ignore' })
      const behind = execSync(`git log --oneline ${body.commit}..HEAD`, { cwd: ROOT, encoding: 'utf8' }).trim()
      if (behind) {
        info(`production is BEHIND by ${behind.split('\n').length} commit(s):`)
        for (const line of behind.split('\n')) info(`    ${line}`)
        info('wait for the Vercel build, or check the dashboard if it did not start')
      } else {
        info('production is AHEAD of local HEAD. Pull before you conclude anything.')
      }
    } catch {
      info('that commit is not in this clone, so it was built from a different branch or fork')
    }
  }

  info('read-only: nothing was written and no session was used')
  verdict('deployed version')
}
main()
