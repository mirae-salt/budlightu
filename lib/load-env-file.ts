/**
 * Minimal .env parser for local diagnostic scripts.
 *
 * P1-26: the hand-rolled parsers in scripts/test-resend.ts and
 * scripts/test-gmail.ts matched `/^([A-Z_]+)=(.*)$/`, which fails in two ways
 * that both hide the real problem:
 *
 *   1. A UTF-8 BOM at the start of .env.local becomes part of the FIRST key, so
 *      `^[A-Z_]+` does not match and that variable is silently skipped. These
 *      are the scripts you run when email is broken, so they told you the API
 *      key was missing when it was right there.
 *   2. `[A-Z_]+` excludes digits, so any name like `MS_TENANT_ID_2` or
 *      `SMTP_PORT_465` was skipped too.
 *
 * This parser strips the BOM, accepts real env var names, strips quotes and
 * invisible characters, and REPORTS what it loaded (name plus value length) so a
 * corrupted value is visible rather than inferred.
 *
 * Not for production use: the app reads env from the platform, not from disk.
 */
import { readFileSync, existsSync } from 'node:fs'
import { stripInvisible } from './sanitize'

const KEY_VALUE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

export type LoadedEnv = {
  loaded: Array<{ name: string; length: number; hadInvisible: boolean; hadQuotes: boolean }>
  skipped: Array<{ line: number; text: string }>
}

function unquote(raw: string): { value: string; hadQuotes: boolean } {
  const v = raw.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return { value: v.slice(1, -1), hadQuotes: true }
  }
  return { value: v, hadQuotes: false }
}

/**
 * Reads a .env style file into process.env (existing values are NOT overwritten
 * unless `override` is true) and returns a report of what happened.
 */
export function loadEnvFile(path = '.env.local', opts: { override?: boolean } = {}): LoadedEnv {
  const report: LoadedEnv = { loaded: [], skipped: [] }

  if (!existsSync(path)) {
    console.warn(`[env] ${path} not found. Relying on the ambient environment.`)
    return report
  }

  let text = readFileSync(path, 'utf8')

  // Strip a leading BOM. This one character is the entire bug.
  if (text.charCodeAt(0) === 0xfeff) {
    console.warn(`[env] ${path} starts with a UTF-8 BOM. Stripping it. Re-save the file as UTF-8 without BOM.`)
    text = text.slice(1)
  }

  const lines = text.split(/\r?\n/)

  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const m = trimmed.match(KEY_VALUE)
    if (!m) {
      // Rule 3 of ENGINEERING-RULES: a line we cannot parse is a finding, not noise.
      report.skipped.push({ line: i + 1, text: trimmed.slice(0, 40) })
      return
    }

    const name = m[1]
    const { value: quoted, hadQuotes } = unquote(m[2])
    const clean = stripInvisible(quoted).trim()
    const hadInvisible = clean !== quoted.trim()

    if (hadInvisible) {
      console.warn(`[env] ${name} contained invisible characters (BOM or zero-width). Stripped for this run, but the stored value is still corrupt.`)
    }

    if (opts.override || process.env[name] === undefined) {
      process.env[name] = clean
    }
    report.loaded.push({ name, length: clean.length, hadInvisible, hadQuotes })
  })

  if (report.skipped.length > 0) {
    console.warn(`[env] ${report.skipped.length} line(s) in ${path} could not be parsed:`)
    for (const s of report.skipped) console.warn(`[env]   line ${s.line}: ${s.text}`)
  }

  return report
}

/**
 * Prints the loaded variable names with value lengths. Never prints a value:
 * length plus presence is what you need to spot a BOM or an empty secret, and it
 * is safe to paste into a ticket.
 */
export function printEnvReport(report: LoadedEnv, interesting: string[] = []): void {
  console.log(`[env] loaded ${report.loaded.length} variable(s)`)
  const names = interesting.length > 0 ? interesting : report.loaded.map(l => l.name)
  for (const name of names) {
    const entry = report.loaded.find(l => l.name === name)
    const live = process.env[name]
    if (!entry && live === undefined) {
      console.log(`[env]   ${name}: MISSING`)
      continue
    }
    const len = (live ?? '').length
    const flags = [
      entry?.hadInvisible ? 'had-invisible-chars' : null,
      entry?.hadQuotes ? 'was-quoted' : null,
      len === 0 ? 'EMPTY' : null
    ].filter(Boolean).join(' ')
    console.log(`[env]   ${name}: length=${len}${flags ? ` (${flags})` : ''}`)
  }
}
