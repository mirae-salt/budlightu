import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { reasonProblem, reasonOk, MIN_REASON_LENGTH, MAX_REASON_LENGTH } from '../lib/reason'

describe('reasonProblem', () => {
  it('a blank reason is refused, and the message says it is required', () => {
    for (const bad of [undefined, null, '', '   ', '\t\n']) {
      const msg = reasonProblem(bad)
      expect(msg, `${JSON.stringify(bad)} must be refused`).toBeTruthy()
      expect(msg).toMatch(/required/i)
    }
  })

  it('a short real answer is accepted', () => {
    // Ten characters rejected honest answers. These must all pass.
    for (const good of ['typo', 'wrong bank', 'new account', 'mis-click']) {
      expect(reasonOk(good), `${good} must be accepted`).toBe(true)
    }
  })

  it('too short says how many characters, and gives an example', () => {
    const msg = reasonProblem('x')
    expect(msg).toBeTruthy()
    expect(msg).toContain(String(MIN_REASON_LENGTH))
    expect(msg).toMatch(/typo/)
  })

  it('a novel is refused', () => {
    expect(reasonOk('x'.repeat(MAX_REASON_LENGTH + 1))).toBe(false)
  })

  it('the label appears in the message so the field is identifiable', () => {
    expect(reasonProblem('', 'Reason for voiding')).toMatch(/Reason for voiding/)
  })

  it('every message explains the problem rather than only stating failure', () => {
    for (const bad of ['', 'x', 'y'.repeat(MAX_REASON_LENGTH + 1)]) {
      const msg = reasonProblem(bad) as string
      expect(msg.length, `"${bad.slice(0, 8)}" needs a real explanation`).toBeGreaterThan(25)
    }
  })
})

describe('no route re-implements the reason rule', () => {
  // The rule lived in six places with six different minimums (1, 3, 3, 4, 5, 5).
  // The same word was accepted in one screen and refused in another, and most
  // callers only greyed a button out. Keep it in one module.
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('no file hardcodes a reason-length comparison', () => {
    const offenders: string[] = []
    for (const f of [...walk('app'), ...walk('lib')]) {
      if (f.includes('reason.ts')) continue   // the module itself
      const src = readFileSync(f, 'utf8')
      // e.g. `reason.length < 5`, `reason.trim().length >= 10`
      const re = /reason[A-Za-z]*\s*(?:\.trim\(\))?\s*\.length\s*[<>]=?\s*\d+/g
      for (const m of src.match(re) ?? []) offenders.push(`${f}: ${m}`)
    }
    expect(offenders, 'use reasonProblem() from lib/reason.ts instead').toEqual([])
  })
})
