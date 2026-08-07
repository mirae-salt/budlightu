import { describe, it, expect } from 'vitest'
import { ensureInitialsResolved } from '../lib/ensure-initials'

type Row = Record<string, any>
function fakeDb(tables: Record<string, Row[]>) {
  function q(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    const api: any = {
      _mode: 'select', _payload: null as any,
      select() { return api },
      update(p: Row) { api._mode = 'update'; api._payload = p; return api },
      eq(c: string, v: any) { filters.push(r => String(r[c]) === String(v)); return api },
      is(c: string, v: any) { filters.push(r => (v === null ? r[c] == null : r[c] === v)); return api },
      then(res: any, rej: any) { return api._run().then(res, rej) },
      async _run() {
        const rows = tables[table] ?? []
        const matched = rows.filter(r => filters.every(f => f(r)))
        if (api._mode === 'update') {
          // emulate UNIQUE (cohort_id, initials_resolved)
          for (const r of matched) {
            if (rows.some(o => o !== r && o.cohort_id === r.cohort_id && o.initials_resolved === api._payload.initials_resolved)) {
              return { data: null, error: { message: 'duplicate key bams_initials_unique' } }
            }
            Object.assign(r, api._payload)
          }
          return { data: matched, error: null }
        }
        return { data: matched, error: null }
      }
    }
    return api
  }
  return { from: (t: string) => q(t) }
}

describe('P1-11 ensureInitialsResolved', () => {
  it('resolves a NULL value and persists it', async () => {
    const bams = [{ id: 'b1', cohort_id: 'c', first_name: 'Émile', last_name: 'Côté', initials_resolved: null }]
    const db: any = fakeDb({ bams })
    const r = await ensureInitialsResolved(db, 'b1', 'c')
    expect(r).toEqual({ ok: true, initials: 'EC', created: true })
    expect(bams[0].initials_resolved).toBe('EC')
  })

  it('does not collide with an already-persisted sibling', async () => {
    const bams = [
      { id: 'b1', cohort_id: 'c', first_name: 'Lucas', last_name: 'Grabowski', initials_resolved: 'LG' },
      { id: 'b2', cohort_id: 'c', first_name: 'Luke', last_name: 'Grabowski', initials_resolved: null }
    ]
    const db: any = fakeDb({ bams })
    const r = await ensureInitialsResolved(db, 'b2', 'c')
    expect(r.ok).toBe(true)
    expect((r as any).initials).not.toBe('LG')
    expect(bams[0].initials_resolved).toBe('LG')  // never rewritten
  })

  it('replaces a legacy unusable value like AK1', async () => {
    const bams = [{ id: 'b1', cohort_id: 'c', first_name: 'Alex', last_name: 'Kim', initials_resolved: 'AK1' }]
    const db: any = fakeDb({ bams })
    const r = await ensureInitialsResolved(db, 'b1', 'c')
    expect(r).toEqual({ ok: true, initials: 'AK', created: true })
  })

  it('keeps an existing usable value', async () => {
    const bams = [{ id: 'b1', cohort_id: 'c', first_name: 'Alex', last_name: 'Kim', initials_resolved: 'AKZ' }]
    const db: any = fakeDb({ bams })
    expect(await ensureInitialsResolved(db, 'b1', 'c')).toEqual({ ok: true, initials: 'AKZ', created: false })
  })

  it('refuses when the bam is not in the cohort', async () => {
    const db: any = fakeDb({ bams: [{ id: 'other', cohort_id: 'c', first_name: 'A', last_name: 'B', initials_resolved: null }] })
    const r = await ensureInitialsResolved(db, 'b1', 'c')
    expect(r.ok).toBe(false)
    expect((r as any).error).toMatch(/not in cohort/)
  })

  it('fails closed on a read error', async () => {
    const db: any = { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }
    const r = await ensureInitialsResolved(db, 'b1', 'c')
    expect(r.ok).toBe(false)
  })
})
