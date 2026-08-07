/**
 * Q: Does this env value contain an invisible character?
 *
 * A UTF-8 BOM prepended by a shell pipeline made every emailed link invalid for a
 * whole session while every log and UI rendered it as correct. Values are never
 * printed: length, byte prefix and a shape verdict only.
 *
 * Usage: node scripts/probe/config-bytes.js NEXT_PUBLIC_APP_URL AP_EMAIL
 */
const { loadEnv, pass, fail, info, verdict } = require('./_lib')

const INVISIBLE = [
  [0xfeff, 'U+FEFF BOM'], [0x200b, 'U+200B zero-width space'],
  [0x200c, 'U+200C ZWNJ'], [0x200d, 'U+200D ZWJ'], [0x2060, 'U+2060 word joiner'],
  [0x00a0, 'U+00A0 non-breaking space'], [0x00ad, 'U+00AD soft hyphen']
]

async function main() {
  loadEnv()
  const names = process.argv.slice(2)
  if (!names.length) {
    console.error('usage: node scripts/probe/config-bytes.js <ENV_NAME> [ENV_NAME ...]')
    process.exit(2)
  }
  for (const name of names) {
    const v = process.env[name]
    if (v === undefined) { fail(`${name}: not set`); continue }

    const found = []
    for (const ch of v) {
      const cp = ch.codePointAt(0)
      const hit = INVISIBLE.find(([c]) => c === cp)
      if (hit) found.push(hit[1])
      else if (cp < 0x20 || cp === 0x7f) found.push('U+' + cp.toString(16).padStart(4, '0') + ' control')
    }
    const trimmed = v !== v.trim()
    if (found.length) fail(`${name}: contains ${[...new Set(found)].join(', ')} (len ${v.length})`)
    else if (trimmed) fail(`${name}: has leading/trailing whitespace (len ${v.length})`)
    else pass(`${name}: clean (len ${v.length}, starts "${v.slice(0, 8)}")`)
  }
  info('to see raw bytes: printf %s "$VALUE" | od -c | head -3')
  verdict('config bytes')
}
main()
