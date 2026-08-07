/**
 * Shared setup for probes.
 *
 * Probes exist because in one session eight throwaway verification scripts were
 * written and deleted, and the ninth question got guessed at instead. Guessing
 * only wins when checking is expensive, so the checks live here permanently.
 *
 * Rules (see ~/.claude/VERIFICATION-RULES-GENERIC.md Part C):
 *   - read-only unless the filename starts with `fix-`
 *   - print a VERDICT line, not a data dump
 *   - exit non-zero on FAIL so this can be chained into a deploy check
 *   - never print a secret; length, last 4, or a hash only
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')

/** Loads .env.local without dotenv, tolerating a BOM and CRLF. */
function loadEnv() {
  const file = path.join(ROOT, '.env.local')
  if (!fs.existsSync(file)) {
    console.error(`FAIL  .env.local not found at ${file}`)
    process.exit(1)
  }
  // Strip a leading BOM: `^([A-Za-z_]...)` does not match U+FEFF, so a BOM'd
  // file silently loses its first variable. That exact bug sent every invite
  // email to a broken URL for a whole session.
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) process.env[m[1]] = m[2].trim()
  }
}

function serviceClient() {
  loadEnv()
  const { createClient } = require(path.join(ROOT, 'node_modules', '@supabase', 'supabase-js'))
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('FAIL  NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing')
    process.exit(1)
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

let failed = false
const pass = m => console.log('  PASS  ' + m)
const fail = m => { failed = true; console.log('  FAIL  ' + m) }
const info = m => console.log('  ..    ' + m)

function verdict(label) {
  console.log('')
  console.log(failed ? `VERDICT: FAIL  (${label})` : `VERDICT: PASS  (${label})`)
  process.exit(failed ? 1 : 0)
}

module.exports = { ROOT, loadEnv, serviceClient, pass, fail, info, verdict }
