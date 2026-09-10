/**
 * Writes a Claude Code session transcript out as readable text.
 *
 * The .jsonl the CLI keeps is one JSON record per line and holds far more than the
 * conversation: queue operations, title guesses, mode switches, and every tool result
 * including base64 images. Read as-is it is tens of megabytes and unreadable.
 *
 * This keeps what a person would call the conversation: what was typed, what was
 * answered, and a one-line trace of each tool call so the reasoning still follows. Tool
 * OUTPUT is truncated rather than dropped, because the numbers in it are often the whole
 * point of the exchange, and images are replaced by a note of their size.
 *
 * Usage:
 *   node scripts/export-transcript.js <session.jsonl> <out.txt>
 *   node scripts/export-transcript.js            (defaults to this project's newest)
 */
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const PROJECT_DIR = 'C:/Users/MiraeLee/.claude/projects/C--Dev-BLU-Invoice'
/** Tool output longer than this is cut; the head is where the answer usually is. */
const MAX_TOOL_OUTPUT = 1200

function newestSession() {
  const files = fs.readdirSync(PROJECT_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ f: path.join(PROJECT_DIR, f), t: fs.statSync(path.join(PROJECT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  if (!files.length) throw new Error(`no .jsonl under ${PROJECT_DIR}`)
  return files[0].f
}

/** Pulls readable text out of a content block, naming what it skips. */
function renderBlock(b) {
  if (typeof b === 'string') return b
  if (!b || typeof b !== 'object') return ''
  switch (b.type) {
    case 'text':
      return b.text ?? ''
    case 'thinking':
      // Deliberately dropped. It is not what was said to anyone.
      return ''
    case 'image': {
      const bytes = b.source?.data ? Math.round(String(b.source.data).length * 0.75) : 0
      return `[image, ~${Math.round(bytes / 1024)} KB]`
    }
    case 'tool_use': {
      const input = JSON.stringify(b.input ?? {})
      const short = input.length > 400 ? input.slice(0, 400) + '…' : input
      return `[tool: ${b.name}] ${short}`
    }
    case 'tool_result': {
      const c = b.content
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.map(renderBlock).filter(Boolean).join('\n') : ''
      const cut = text.length > MAX_TOOL_OUTPUT
        ? text.slice(0, MAX_TOOL_OUTPUT) + `\n… [${text.length - MAX_TOOL_OUTPUT} more characters]`
        : text
      return cut ? `[result]\n${cut}` : ''
    }
    default:
      return ''
  }
}

async function main() {
  const src = process.argv[2] || newestSession()
  const out = process.argv[3] || path.join(process.cwd(), 'TRANSCRIPT.txt')

  const w = fs.createWriteStream(out, { encoding: 'utf8' })
  w.write(`Claude Code transcript\n`)
  w.write(`source : ${src}\n`)
  w.write(`written: ${new Date().toISOString()}\n`)
  w.write(`note   : thinking blocks are omitted; tool output is truncated at ${MAX_TOOL_OUTPUT} characters\n`)
  w.write('='.repeat(78) + '\n\n')

  let kept = 0
  let skipped = 0
  const rl = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity })

  for await (const line of rl) {
    let j
    try { j = JSON.parse(line) } catch { skipped++; continue }
    if (j.type !== 'user' && j.type !== 'assistant') { skipped++; continue }

    const msg = j.message ?? j
    const content = msg.content
    const body = Array.isArray(content)
      ? content.map(renderBlock).filter(Boolean).join('\n')
      : renderBlock(content)
    if (!body.trim()) { skipped++; continue }

    const when = j.timestamp ? String(j.timestamp).replace('T', ' ').slice(0, 19) : ''
    w.write(`----- ${j.type.toUpperCase()} ${when} -----\n${body}\n\n`)
    kept++
  }

  await new Promise(r => w.end(r))
  const size = fs.statSync(out).size
  console.log(`wrote ${out}`)
  console.log(`  turns written : ${kept}`)
  console.log(`  records skipped: ${skipped} (queue ops, titles, modes, empty)`)
  console.log(`  size          : ${(size / 1024 / 1024).toFixed(2)} MB`)
}
main().catch(e => { console.error(String(e.message ?? e)); process.exit(1) })
