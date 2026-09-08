/**
 * The bell used to only count up.
 *
 * A notification became read when somebody clicked it, and nothing ever closed one
 * because the work behind it was finished. On 2026-09-08 it said 27 unread and 12 of
 * those were done, nine of them cleared by a script an hour earlier. A counter that is
 * mostly wrong stops meaning "waiting for you" and nobody opens it.
 */
import { describe, it, expect } from 'vitest'
import { syncAdminNotifications, hasOpenNotification } from '../lib/notify-admin'

type Row = Record<string, unknown>

/**
 * Enough of the query builder for these two functions, and it records the writes.
 *
 * Thenable, like the real one: filters and `select` all return the builder and the query
 * runs when it is awaited. A mock that ends the chain at `select()` passes on a shape the
 * app never produces, which is the whole hazard of hand-written mocks.
 */
function mockDb(tables: { receipts: Row[]; admin_notifications: Row[] }) {
  const writes: Array<{ table: string; patch: Row; matched: number }> = []

  function builder(table: string) {
    let rows = [...(tables[table as keyof typeof tables] ?? [])]
    let patch: Row | null = null

    const self = {
      select: () => self,
      update: (p: Row) => { patch = p; return self },
      eq: (k: string, v: unknown) => { rows = rows.filter(r => r[k] === v); return self },
      in: (k: string, vs: unknown[]) => { rows = rows.filter(r => vs.includes(r[k])); return self },
      limit: (n: number) => { rows = rows.slice(0, n); return self },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        if (patch) {
          for (const r of rows) Object.assign(r, patch)
          writes.push({ table, patch, matched: rows.length })
        }
        return Promise.resolve({ data: rows, error: null }).then(resolve)
      }
    }
    return self
  }

  return { db: { from: (t: string) => builder(t) }, writes }
}

const BAM = 'bam-1'
const PERIOD = '2026-09-01'

describe('syncAdminNotifications', () => {
  it('closes a review notification once the receipt has been decided', async () => {
    const { db } = mockDb({
      receipts: [{ bam_id: BAM, period: PERIOD, status: 'auto_pass' }],
      admin_notifications: [
        { id: 'n1', type: 'receipt_review', bam_id: BAM, period: PERIOD, read: false }
      ]
    })
    const out = await syncAdminNotifications(db as never, { bamId: BAM, period: PERIOD })
    expect(out).toEqual({ ok: true, closed: 1 })
  })

  it('leaves it open while a receipt is still in review', async () => {
    // Emma Crowder had two at once. Closing on the first decision would bury the second.
    const { db } = mockDb({
      receipts: [
        { bam_id: BAM, period: PERIOD, status: 'approved' },
        { bam_id: BAM, period: PERIOD, status: 'review' }
      ],
      admin_notifications: [
        { id: 'n1', type: 'receipt_review', bam_id: BAM, period: PERIOD, read: false },
        { id: 'n2', type: 'receipt_review', bam_id: BAM, period: PERIOD, read: false }
      ]
    })
    const out = await syncAdminNotifications(db as never, { bamId: BAM, period: PERIOD })
    expect(out).toEqual({ ok: true, closed: 0 })
  })

  it('closes a failed read once a retry has worked, and leaves the review one alone', async () => {
    const { db } = mockDb({
      receipts: [{ bam_id: BAM, period: PERIOD, status: 'review' }],
      admin_notifications: [
        { id: 'n1', type: 'ocr_failed', bam_id: BAM, period: PERIOD, read: false },
        { id: 'n2', type: 'receipt_review', bam_id: BAM, period: PERIOD, read: false }
      ]
    })
    const out = await syncAdminNotifications(db as never, { bamId: BAM, period: PERIOD })
    expect(out).toEqual({ ok: true, closed: 1 })
  })

  it('never touches another BAM or another month', async () => {
    const { db, writes } = mockDb({
      receipts: [{ bam_id: BAM, period: PERIOD, status: 'approved' }],
      admin_notifications: [
        { id: 'mine', type: 'receipt_review', bam_id: BAM, period: PERIOD, read: false },
        { id: 'theirs', type: 'receipt_review', bam_id: 'bam-2', period: PERIOD, read: false },
        { id: 'lastmonth', type: 'receipt_review', bam_id: BAM, period: '2026-08-01', read: false }
      ]
    })
    await syncAdminNotifications(db as never, { bamId: BAM, period: PERIOD })
    expect(writes).toHaveLength(1)
    expect(writes[0].matched).toBe(1)
  })

  it('reports a read failure instead of claiming it closed things', async () => {
    const boom = { select() { return boom }, eq() { return boom }, in() { return boom }, limit() { return boom },
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(r) }
    const db = { from: () => boom }
    const out = await syncAdminNotifications(db as never, { bamId: BAM, period: PERIOD })
    expect(out.ok).toBe(false)
  })
})

describe('hasOpenNotification', () => {
  const notes = [{ id: 'n1', type: 'shortfall', bam_id: BAM, period: PERIOD, read: false }]

  it('is true while one is already open', async () => {
    // Thomas Levesque got "$24.32 spent" and "$109.58 spent" on the same day; only the
    // last was ever true.
    const { db } = mockDb({ receipts: [], admin_notifications: notes })
    expect(await hasOpenNotification(db as never, { type: 'shortfall', bamId: BAM, period: PERIOD })).toBe(true)
  })

  it('is false for a different month', async () => {
    const { db } = mockDb({ receipts: [], admin_notifications: notes })
    expect(await hasOpenNotification(db as never, { type: 'shortfall', bamId: BAM, period: '2026-10-01' })).toBe(false)
  })

  it('is false once the open one has been read', async () => {
    const { db } = mockDb({ receipts: [], admin_notifications: [{ ...notes[0], read: true }] })
    expect(await hasOpenNotification(db as never, { type: 'shortfall', bamId: BAM, period: PERIOD })).toBe(false)
  })

  it('is false when we cannot tell, so a duplicate beats a lost notification', async () => {
    const boom = { select() { return boom }, eq() { return boom }, in() { return boom }, limit() { return boom },
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(r) }
    const db = { from: () => boom }
    expect(await hasOpenNotification(db as never, { type: 'shortfall', bamId: BAM, period: PERIOD })).toBe(false)
  })
})
