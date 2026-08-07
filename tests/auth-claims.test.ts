/**
 * P0-A regression suite.
 *
 * The hole: every authorization decision read `user_metadata.role`, and
 * `user_metadata` is writable by the user's own session with only the anon key:
 *
 *     await supabase.auth.updateUser({ data: { role: 'super_admin' } })
 *
 * BAMs are created with role 'bam', so any student could self-promote and then
 * call decrypt_bam_banking() to read all 58 BAMs' transit and account numbers.
 *
 * These tests exist to fail loudly if anyone reintroduces a user_metadata
 * fallback, in code OR in a migration.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getRole, getBamId, isAdminRole, isSuperAdmin, detectRoleTampering, roleClaimPatch
} from '../lib/auth-claims'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, ...p.split('/')), 'utf8')

describe('P0-A · user_metadata.role is NOT honoured', () => {
  it('a self-promoted super_admin in user_metadata is ignored', () => {
    const attacker = {
      app_metadata: { role: 'bam' },
      user_metadata: { role: 'super_admin' }
    }
    expect(getRole(attacker)).toBe('bam')
    expect(isAdminRole(getRole(attacker))).toBe(false)
    expect(isSuperAdmin(getRole(attacker))).toBe(false)
  })

  it('a role present ONLY in user_metadata grants nothing', () => {
    const attacker = { app_metadata: {}, user_metadata: { role: 'program_admin' } }
    expect(getRole(attacker)).toBeNull()
    expect(isAdminRole(getRole(attacker))).toBe(false)
  })

  it('the escalation attempt is detectable for logging', () => {
    expect(detectRoleTampering({
      app_metadata: { role: 'bam' }, user_metadata: { role: 'super_admin' }
    })).toEqual({ tampered: true, claimed: 'super_admin' })

    // A matching pair, or a non-privileged claim, is not tampering.
    expect(detectRoleTampering({
      app_metadata: { role: 'super_admin' }, user_metadata: { role: 'super_admin' }
    }).tampered).toBe(false)
    expect(detectRoleTampering({
      app_metadata: { role: 'bam' }, user_metadata: { role: 'bam' }
    }).tampered).toBe(false)
  })

  it('a real admin claim in app_metadata is honoured', () => {
    expect(getRole({ app_metadata: { role: 'super_admin' } })).toBe('super_admin')
    expect(getRole({ app_metadata: { role: 'program_admin' } })).toBe('program_admin')
    expect(isAdminRole(getRole({ app_metadata: { role: 'program_admin' } }))).toBe(true)
    expect(isSuperAdmin(getRole({ app_metadata: { role: 'program_admin' } }))).toBe(false)
  })
})

describe('P0-A · getRole fails closed', () => {
  it.each([
    ['null user', null],
    ['undefined user', undefined],
    ['no metadata at all', {}],
    ['empty app_metadata', { app_metadata: {} }],
    ['empty string role', { app_metadata: { role: '' } }],
    ['unknown role value', { app_metadata: { role: 'root' } }],
    ['role is a number', { app_metadata: { role: 1 } }],
    ['role is an object', { app_metadata: { role: { role: 'super_admin' } } }],
    ['app_metadata is an array', { app_metadata: [{ role: 'super_admin' }] }],
    ['app_metadata is a string', { app_metadata: 'super_admin' }],
  ])('%s denies', (_label, user) => {
    // Cast: these are deliberately malformed shapes a tampered JWT could carry.
    const role = getRole(user as Parameters<typeof getRole>[0])
    expect(isAdminRole(role)).toBe(false)
    expect(isSuperAdmin(role)).toBe(false)
  })
})

describe('P0-A step 5 · bam_id claim', () => {
  const real = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

  it('reads app_metadata only', () => {
    expect(getBamId({ app_metadata: { bam_id: real } })).toBe(real)
    expect(getBamId({ user_metadata: { bam_id: real } })).toBeNull()
  })

  it('rejects a non-uuid claim so it can never reach a query', () => {
    expect(getBamId({ app_metadata: { bam_id: 'not-a-uuid' } })).toBeNull()
    expect(getBamId({ app_metadata: { bam_id: `${real}' or '1'='1` } })).toBeNull()
    expect(getBamId({ app_metadata: { bam_id: '' } })).toBeNull()
  })
})

describe('P1-21 · revocation writes an explicit null, never undefined', () => {
  it('role removal produces a null value that survives JSON.stringify', () => {
    const patch = roleClaimPatch({ role: 'super_admin', bam_id: 'x' }, { role: null })
    expect(patch.role).toBeNull()
    // The original bug: `{ ...meta, role: undefined }` loses the key entirely,
    // and GoTrue only deletes a key when it is explicitly null.
    expect(JSON.parse(JSON.stringify(patch))).toHaveProperty('role', null)
    expect(Object.keys(JSON.parse(JSON.stringify(patch)))).toContain('role')
  })

  it('merges rather than replaces, so bam_id is never dropped', () => {
    const patch = roleClaimPatch({ bam_id: 'keep-me', other: 1 }, { role: 'program_admin' })
    expect(patch).toEqual({ bam_id: 'keep-me', other: 1, role: 'program_admin' })
  })
})

describe('P0-A · no code path reads a role out of user_metadata', () => {
  /**
   * Strips comments and string literal CONTENTS so that prose explaining the bug,
   * and log messages naming it, do not trip the scan. Only executable code is
   * left. Strings are blanked (not deleted) so bracket access on a string key is
   * still detectable.
   */
  function codeOnly(src: string): string {
    const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '')
    const blankedStrings = noBlockComments
      .replace(/`(?:\\.|[^`\\])*`/g, '``')              // template literals
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")            // single-quoted strings
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')            // double-quoted strings
    // Line comments are removed AFTER blanking strings so a "//" inside a string
    // (a URL, for instance) cannot truncate real code.
    return blankedStrings.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
  }

  /**
   * Patterns that READ a role out of the client-writable bag. Writes such as
   * `user_metadata: { ..., role: null }` (legacy cleanup) are not reads and are
   * intentionally not matched.
   */
  const ROLE_READ_PATTERNS = [
    /user_metadata[^\n]*\)\s*\??\.\s*role\b/,                 // (u.user_metadata as {...}).role
    /user_metadata\s*\??\.\s*role\b/,                         // user_metadata.role / ?.role
    /user_metadata\s*\[\s*(?:''|""|['"]role['"])\s*\]/,        // user_metadata['role'] (key blanked by codeOnly)
  ]

  // lib/auth-claims.ts is excluded on purpose: detectRoleTampering() reads the
  // bag deliberately so an escalation attempt can be LOGGED. The unit tests above
  // prove that value never authorizes anything.
  const files = [
    'middleware.ts',
    'lib/admin-auth.ts',
    'app/api/admin/team/route.ts',
    'app/api/admin/roster/route.ts',
    'app/api/admin/data/route.ts',
    'app/api/admin/notifications/route.ts',
    'app/api/verify-account/tail/route.ts',
    'app/api/auth/roster-check/route.ts',
  ]

  it.each(files)('%s does not read a role from user_metadata', file => {
    const code = codeOnly(read(file))
    for (const pattern of ROLE_READ_PATTERNS) {
      expect(code, `${file} matched ${pattern}`).not.toMatch(pattern)
    }
  })

  it('the scan actually catches the original vulnerable line', () => {
    // Guards against the patterns, or codeOnly(), silently rotting into a no-op.
    const vulnerable = 'const role = (user.user_metadata as { role?: string }).role'
    expect(ROLE_READ_PATTERNS.some(p => p.test(codeOnly(vulnerable)))).toBe(true)
    expect(ROLE_READ_PATTERNS.some(p => p.test(codeOnly('const r = u.user_metadata?.role')))).toBe(true)
    expect(ROLE_READ_PATTERNS.some(p => p.test(codeOnly("const r = u.user_metadata['role']")))).toBe(true)
  })

  it('codeOnly keeps real code while dropping comments and strings', () => {
    expect(codeOnly('const a = 1 // user_metadata.role')).not.toContain('user_metadata')
    expect(codeOnly('console.error("user_metadata.role")')).not.toContain('user_metadata')
    expect(codeOnly('const r = x.user_metadata.role')).toContain('user_metadata.role')
  })

  it('middleware imports the trusted claim reader', () => {
    const src = read('middleware.ts')
    expect(src).toMatch(/from '\.\/lib\/auth-claims'/)
    expect(src).toMatch(/getRole\(user\)/)
  })

  it('getRole reads app_metadata and nothing else', () => {
    const src = read('lib/auth-claims.ts')
    const getRoleBody = src.slice(src.indexOf('export function getRole'), src.indexOf('export function getBamId'))
    expect(getRoleBody).toContain('app_metadata')
    expect(getRoleBody).not.toContain('user_metadata')
  })

  it('getBamId reads app_metadata and nothing else', () => {
    const src = read('lib/auth-claims.ts')
    const body = src.slice(src.indexOf('export function getBamId'), src.indexOf('export function isAdminRole'))
    expect(body).toContain('app_metadata')
    expect(body).not.toContain('user_metadata')
  })

  it('the tail route resolves the BAM from the database, not from a JWT claim', () => {
    const src = read('app/api/verify-account/tail/route.ts')
    expect(src).toMatch(/requireBam\(\)/)
    expect(codeOnly(src)).not.toContain('user_metadata')
  })
})

describe('P0-A · migration moves current_role_claim() to app_metadata', () => {
  const mig = read('supabase/migrations/0016_auth_hardening.sql')

  it('redefines current_role_claim() against app_metadata', () => {
    expect(mig).toMatch(/create or replace function current_role_claim\(\)/i)
    expect(mig).toMatch(/auth\.jwt\(\)->'app_metadata'->>'role'/)
  })

  it('the new function body does not read user_metadata', () => {
    const body = mig.slice(
      mig.indexOf('create or replace function current_role_claim()'),
      mig.indexOf('comment on function current_role_claim()')
    )
    expect(body).not.toContain('user_metadata')
  })

  it('falls back to the least-privileged role, not to an admin role', () => {
    expect(mig).toMatch(/coalesce\(\s*nullif\(auth\.jwt\(\)->'app_metadata'->>'role', ''\),\s*'bam'\s*\)/)
  })

  it('refuses to apply if the claim source ever regresses', () => {
    expect(mig).toMatch(/Refusing to apply/)
    expect(mig).toMatch(/v_src like '%user_metadata%'/)
  })

  it('backfills existing roles without overwriting an existing app_metadata role', () => {
    expect(mig).toMatch(/raw_app_meta_data/)
    expect(mig).toMatch(/coalesce\(u\.raw_app_meta_data->>'role', ''\) = ''/)
  })
})

describe('P0-A2 · middleware fails closed', () => {
  const src = read('middleware.ts')

  it('a missing env var no longer waves traffic through', () => {
    expect(src).not.toMatch(/if \(!url \|\| !anon\) return NextResponse\.next\(\)/)
    expect(src).toMatch(/if \(!url \|\| !anon\) \{[\s\S]{0,400}configErrorResponse/)
  })

  it('the config failure response is a 503, not a pass', () => {
    expect(src).toMatch(/status: 503/)
  })
})
