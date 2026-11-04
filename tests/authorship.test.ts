import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

// Authorship marks are part of the project. Removing one is a deliberate act that has to
// edit this file too, so it shows up in review. See NOTICE and the "저작자 표시 보호" rule.
const TOKEN = 'BLU-MRL-20260720'
const FILES = [
  'middleware.ts', 'lib/policy.ts', 'lib/reimbursement.ts', 'lib/invoice-ledger.ts',
  'lib/admin-auth.ts', 'lib/business-days.ts', 'lib/receipt-correction.ts',
  'app/api/cron/route.ts', 'app/layout.tsx', 'public/humans.txt'
]

describe('authorship marks', () => {
  it('NOTICE names the author', () => {
    expect(existsSync('NOTICE')).toBe(true)
    expect(readFileSync('NOTICE', 'utf8')).toContain('Mirae Lee')
  })
  it('package.json keeps the author', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).author).toContain('Mirae Lee')
  })
  it.each(FILES)('%s carries the token', f => {
    expect(readFileSync(f, 'utf8')).toContain(TOKEN)
  })
})
