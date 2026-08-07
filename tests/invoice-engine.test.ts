import { describe, it, expect } from 'vitest'
import { baseInitials, resolveInitials, foldLatinLetters, isUsableInitials } from '../lib/initials'
import { formatInvoiceNumber } from '../lib/invoice-numbering'
import { normalizeForPdf, unrenderableChars } from '../lib/pdf-text'
import { payloadLedgerMismatch, reimbursementLineTotal, lookupReimbursement } from '../lib/invoice-ledger'
import { claimSend, markSendSucceeded, markSendFailed, markSendDrafted } from '../lib/send-guard'
import { sanitizePoNumber, cleanAddress, addressProblem, envAddressListOr } from '../lib/sanitize'
import { resolveSeqAndRevision } from '../lib/invoice-sequence'
import { computeHst } from '../lib/invoice-payload'

describe('P1-7 accent folding', () => {
  it('folds instead of deleting', () => {
    expect(foldLatinLetters('Émile')).toBe('EMILE')
    expect(baseInitials({ firstName: 'Émile', lastName: 'Côté' })).toBe('EC')
    expect(baseInitials({ firstName: 'Michał', lastName: 'Nowak' })).toBe('MN')
  })
  it('never produces a value formatInvoiceNumber rejects', () => {
    const cases: Array<[string, string]> = [
      ['Ana', ''], ['', ''], ['李', '王'], ['Émile', 'Côté'], ['Ali', 'Ó'], ['Владимир', 'Петров']
    ]
    for (const [f, l] of cases) {
      const init = baseInitials({ firstName: f, lastName: l })
      expect(isUsableInitials(init), `${f}/${l} -> ${init}`).toBe(true)
      expect(() => formatInvoiceNumber(init, 1)).not.toThrow()
    }
  })
  it('is deterministic for non-Latin names', () => {
    expect(baseInitials({ firstName: '李', lastName: '王' })).toBe(baseInitials({ firstName: '李', lastName: '王' }))
    expect(baseInitials({ firstName: '李', lastName: '王' })).not.toBe(baseInitials({ firstName: '陳', lastName: '林' }))
  })
  it('collision fallback satisfies formatInvoiceNumber', () => {
    const out = resolveInitials([
      { id: '1', firstName: 'Alex', lastName: 'Kim' },
      { id: '2', firstName: 'Alex', lastName: 'Kim' },
      { id: '3', firstName: '李', lastName: '' },
      { id: '4', firstName: '李', lastName: '' }
    ])
    expect(new Set(out.map(o => o.initials)).size).toBe(4)
    for (const o of out) expect(() => formatInvoiceNumber(o.initials, 1)).not.toThrow()
  })
  it('keeps the documented LG escalation ladder', () => {
    const out = resolveInitials([
      { id: 'lucas', firstName: 'Lucas', lastName: 'Grabowski' },
      { id: 'luke', firstName: 'Luke', lastName: 'Grabowski' }
    ])
    const m = new Map(out.map(o => [o.bamId, o.initials]))
    expect(m.get('lucas')).toBe('LUCGR')
    expect(m.get('luke')).toBe('LUKGR')
  })
})

describe('P1-22 revision suffix', () => {
  it('rev 1 unchanged, rev 2 suffixed', () => {
    expect(formatInvoiceNumber('LG', 3)).toBe('INV-LG3')
    expect(formatInvoiceNumber('LG', 3, 1)).toBe('INV-LG3')
    expect(formatInvoiceNumber('LG', 3, 2)).toBe('INV-LG3-R2')
  })
})

describe('P1-9 pdf text', () => {
  it('NFD accents are fixed by NFC', () => {
    const nfd = 'E\u0301mile'
    expect(unrenderableChars(nfd).length).toBe(1)
    expect(normalizeForPdf({ name: nfd }).name).toBe('Émile')
  })
  it('unrenderable glyphs hard-fail instead of printing wrong letters', () => {
    expect(() => normalizeForPdf({ influencer: { name: 'Michał Nowak' } })).toThrow(/cannot print/)
    expect(() => normalizeForPdf({ a: '张伟' })).toThrow(/U\+5F20/)
  })
  it('leaves banking strings and numbers untouched', () => {
    const p = { directDeposit: { institutionNumber: '003', transitNumber: '00123', accountNumber: '0000456789' }, total: 368.75 }
    const out = normalizeForPdf(p)
    expect(out.directDeposit.institutionNumber).toBe('003')
    expect(out.directDeposit.transitNumber).toBe('00123')
    expect(out.directDeposit.accountNumber).toBe('0000456789')
    expect(out.total).toBe(368.75)
  })
})

describe('P0-D ledger reconciliation', () => {
  const lines = [
    { description: 'Brand Activation Manager monthly payment (July Payment)', total: 218.75 },
    { description: 'Reimbursement for sponsorship allowance (July)', total: 112.4 }
  ]
  it('sums only the reimbursement line', () => {
    expect(reimbursementLineTotal(lines)).toBe(112.4)
  })
  it('passes on match, blocks on mismatch', () => {
    expect(payloadLedgerMismatch(lines, 112.4)).toBeNull()
    expect(payloadLedgerMismatch(lines, 150)).toMatch(/HARD BLOCK/)
    expect(payloadLedgerMismatch(lines, 112.41)).toMatch(/HARD BLOCK/)
    expect(payloadLedgerMismatch([lines[0]], 0)).toBeNull()
    expect(payloadLedgerMismatch([lines[0]], 20)).toMatch(/HARD BLOCK/)
  })
})

type Row = Record<string, any>
function fakeDb(tables: Record<string, Row[]>) {
  let idc = 0
  function q(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    const api: any = {
      _mode: 'select', _payload: null as any,
      select() { return api },
      insert(p: Row) { api._mode = 'insert'; api._payload = p; return api },
      update(p: Row) { api._mode = 'update'; api._payload = p; return api },
      eq(c: string, v: any) { filters.push(r => String(r[c]) === String(v)); return api },
      neq(c: string, v: any) { filters.push(r => String(r[c]) !== String(v)); return api },
      is(c: string, v: any) { filters.push(r => (v === null ? r[c] == null : r[c] === v)); return api },
      in(c: string, vs: any[]) { filters.push(r => vs.includes(r[c])); return api },
      order() { return api }, limit() { return api },
      then(res: any, rej: any) { return api._run().then(res, rej) },
      async _run() {
        const rows = tables[table] ?? (tables[table] = [])
        if (api._mode === 'insert') {
          const row = { id: `id${++idc}`, ...api._payload }
          if (table === 'invoice_sends' && row.sent_at && rows.some(r => r.invoice_id === row.invoice_id && r.target === row.target && r.sent_at)) {
            return { data: null, error: { message: 'duplicate key invoice_sends_one_success' } }
          }
          if (table === 'invoice_sends' && rows.some(r => r.invoice_id === row.invoice_id && r.target === row.target && r.mode === row.mode)) {
            return { data: null, error: { message: 'duplicate key invoice_sends_unique' } }
          }
          rows.push(row)
          return { data: [row], error: null }
        }
        const matched = rows.filter(r => filters.every(f => f(r)))
        if (api._mode === 'update') {
          for (const r of matched) {
            if (table === 'invoice_sends' && api._payload.sent_at &&
                rows.some(o => o !== r && o.invoice_id === r.invoice_id && o.target === r.target && o.sent_at)) {
              return { data: null, error: { message: 'duplicate key invoice_sends_one_success' } }
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
  return { from: (t: string) => q(t), rpc: () => ({ data: null, error: null }), _tables: tables }
}

describe('P0-B/P0-C send idempotency', () => {
  it('blocks a second send, allows retry after failure', async () => {
    const db: any = fakeDb({ invoice_sends: [] })
    const a = await claimSend(db, { invoiceId: 'inv1', target: 'ap', mode: 'live', address: 'ap@x.com' })
    expect(a.ok).toBe(true)
    const b = await claimSend(db, { invoiceId: 'inv1', target: 'ap', mode: 'live', address: 'ap@x.com' })
    expect(b.ok).toBe(false)
    expect((b as any).reason).toBe('in_flight')

    await markSendFailed(db, (a as any).sendRowId, 'smtp down')
    const c = await claimSend(db, { invoiceId: 'inv1', target: 'ap', mode: 'live', address: 'ap@x.com' })
    expect(c.ok).toBe(true)

    expect((await markSendSucceeded(db, (c as any).sendRowId, { messageId: 'm1' })).ok).toBe(true)

    const d = await claimSend(db, { invoiceId: 'inv1', target: 'ap', mode: 'live', address: 'ap@x.com' })
    expect((d as any).reason).toBe('already_sent')
    const e = await claimSend(db, { invoiceId: 'inv1', target: 'ap', mode: 'dryrun', address: 'ap@x.com' })
    expect((e as any).reason).toBe('already_sent')
    expect(db._tables.invoice_sends.filter((r: Row) => r.sent_at).length).toBe(1)
  })

  it('F2: two CONCURRENT retries of a failed send — exactly one may claim it', async () => {
    // The duplicate-payment case. Every other test here is sequential, and the bug
    // was invisible to sequential tests: both callers SELECT the same failed row,
    // both UPDATE it with a predicate that is still true for both, both get a row
    // back, and both call sendEmail. The unique index only trips afterwards, once
    // the second AP email has already gone out.
    //
    // This is the shape an operator produces by double-clicking Retry, or by two
    // scheduler workers overlapping.
    const failedRow: Row = {
      id: 'r1', invoice_id: 'inv1', target: 'ap', mode: 'live',
      status: 'failed', sent_at: null, started_at: null, attempts: 1,
      last_error: 'smtp down'
    }
    const db: any = fakeDb({ invoice_sends: [failedRow] })

    // Start both before awaiting either, so they interleave at the await between
    // the SELECT and the compare-and-set UPDATE.
    const [a, b] = await Promise.all([
      claimSend(db, { invoiceId: 'inv1', target: 'ap', mode: 'live', address: 'ap@x.com' }),
      claimSend(db, { invoiceId: 'inv1', target: 'ap', mode: 'live', address: 'ap@x.com' })
    ])

    const winners = [a, b].filter(r => r.ok)
    const losers = [a, b].filter(r => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect((losers[0] as any).reason).toBe('race')

    // And the row was claimed exactly once, not incremented twice.
    expect(db._tables.invoice_sends).toHaveLength(1)
    expect(db._tables.invoice_sends[0].status).toBe('sending')
    expect(db._tables.invoice_sends[0].attempts).toBe(2)
  })

  it('F2: concurrent FIRST attempts (no existing row) also yield one winner', async () => {
    // The insert path is protected by UNIQUE(invoice_id,target,mode) rather than by
    // the compare-and-set, so cover it too.
    const db: any = fakeDb({ invoice_sends: [] })
    const [a, b] = await Promise.all([
      claimSend(db, { invoiceId: 'inv2', target: 'ap', mode: 'live', address: 'ap@x.com' }),
      claimSend(db, { invoiceId: 'inv2', target: 'ap', mode: 'live', address: 'ap@x.com' })
    ])
    expect([a, b].filter(r => r.ok)).toHaveLength(1)
    expect(db._tables.invoice_sends).toHaveLength(1)
  })

  it('two rows for target=ap do not let the guard pass (the old maybeSingle bug)', async () => {
    const db: any = fakeDb({
      invoice_sends: [
        { id: 'r1', invoice_id: 'inv1', target: 'ap', mode: 'dryrun', status: 'drafted', sent_at: null, started_at: null, attempts: 1 },
        { id: 'r2', invoice_id: 'inv1', target: 'ap', mode: 'live', status: 'sent', sent_at: '2026-08-01T00:00:00Z', started_at: null, attempts: 1 }
      ]
    })
    const c = await claimSend(db, { invoiceId: 'inv1', target: 'ap', mode: 'live', address: 'ap@x.com' })
    expect((c as any).reason).toBe('already_sent')
  })

  it('a DB read error blocks the send (fail closed)', async () => {
    const db: any = { from: () => ({ select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }
    const c = await claimSend(db, { invoiceId: 'inv1', target: 'ap', mode: 'live', address: 'ap@x.com' })
    expect((c as any).reason).toBe('db_error')
  })

  it('dryrun draft does not block the later live send', async () => {
    const db: any = fakeDb({ invoice_sends: [] })
    const a = await claimSend(db, { invoiceId: 'inv2', target: 'ap', mode: 'dryrun', address: 'ap@x.com' })
    expect(a.ok).toBe(true)
    await markSendDrafted(db, (a as any).sendRowId, { messageId: 'draft1' })
    expect((await claimSend(db, { invoiceId: 'inv2', target: 'ap', mode: 'live', address: 'ap@x.com' })).ok).toBe(true)
  })
})

describe('P0-D ledger lookup fail-closed', () => {
  it('uses paid_cad when the row exists', async () => {
    const db: any = fakeDb({ reimbursement_ledger: [{ bam_id: 'b', cohort_id: 'c', period: '2026-07-01', paid_cad: '112.40' }] })
    expect(await lookupReimbursement(db, 'b', 'c', '2026-07-01')).toEqual({ ok: true, paidCad: 112.4, source: 'ledger' })
  })
  it('blocks when no ledger row but receipts exist', async () => {
    const db: any = fakeDb({
      reimbursement_ledger: [],
      receipts: [{ id: 'r1', bam_id: 'b', period: '2026-07-01', status: 'approved' }]
    })
    const r = await lookupReimbursement(db, 'b', 'c', '2026-07-01')
    expect(r.ok).toBe(false)
    expect((r as any).error).toMatch(/no reimbursement_ledger row/)
  })
  it('allows 0 when there are genuinely no receipts', async () => {
    const db: any = fakeDb({ reimbursement_ledger: [], receipts: [] })
    expect(await lookupReimbursement(db, 'b', 'c', '2026-07-01')).toEqual({ ok: true, paidCad: 0, source: 'no_receipts' })
  })
  it('refuses to guess between two ledger rows', async () => {
    const db: any = fakeDb({
      reimbursement_ledger: [
        { bam_id: 'b', cohort_id: 'c', period: '2026-07-01', paid_cad: '100' },
        { bam_id: 'b', cohort_id: 'c', period: '2026-07-01', paid_cad: '150' }
      ]
    })
    expect((await lookupReimbursement(db, 'b', 'c', '2026-07-01')).ok).toBe(false)
  })
})

describe('P1-22 seq/revision', () => {
  it('reissue keeps seq and bumps revision', async () => {
    const db: any = fakeDb({
      invoices: [{ id: 'i1', bam_id: 'b', cohort_id: 'c', period: '2026-07-01', seq: 3, revision: 1, invoice_number: 'INV-LG3', status: 'void' }]
    })
    const r = await resolveSeqAndRevision(db, 'b', 'c', '2026-07-01')
    expect(r).toMatchObject({ ok: true, seq: 3, revision: 2 })
    expect(formatInvoiceNumber('LG', (r as any).seq, (r as any).revision)).toBe('INV-LG3-R2')
  })
  it('a new period never reuses a voided seq', async () => {
    const db: any = fakeDb({
      invoices: [{ id: 'i1', bam_id: 'b', cohort_id: 'c', period: '2026-07-01', seq: 3, revision: 1, status: 'void' }]
    })
    expect(await resolveSeqAndRevision(db, 'b', 'c', '2026-08-01')).toMatchObject({ ok: true, seq: 4, revision: 1 })
  })
  it('existing draft is reported for the update path', async () => {
    const db: any = fakeDb({
      invoices: [{ id: 'i9', bam_id: 'b', cohort_id: 'c', period: '2026-07-01', seq: 2, revision: 1, invoice_number: 'INV-LG2', status: 'draft' }]
    })
    expect(await resolveSeqAndRevision(db, 'b', 'c', '2026-07-01'))
      .toMatchObject({ ok: true, seq: 2, revision: 1, existingId: 'i9', existingStatus: 'draft' })
  })
})

describe('P1-18/P1-19 string hygiene', () => {
  it('strips BOM/NBSP/zero-width from addresses', () => {
    expect(cleanAddress('\ufeffaccounts.payable@ilovesalt.com')).toBe('accounts.payable@ilovesalt.com')
    expect(cleanAddress('ap@x.com\u200b')).toBe('ap@x.com')
    expect(cleanAddress('ap@x.com\u00a0')).toBe('ap@x.com')
    expect(addressProblem('AP_EMAIL', cleanAddress('\ufeffap@x.com'))).toBeNull()
    expect(addressProblem('AP_EMAIL', cleanAddress('not-an-email'))).toMatch(/valid single email/)
    expect(addressProblem('AP_EMAIL', cleanAddress('a@x.com,b@y.com'))).toMatch(/valid single email/)
  })
  it('po_number must be 6 digits after sanitizing', () => {
    expect(sanitizePoNumber('\ufeff260351')).toEqual({ ok: true, value: '260351' })
    expect(sanitizePoNumber(' 260351 ')).toEqual({ ok: true, value: '260351' })
    // An INTERIOR NBSP is rejected, not silently repaired. The old env-clean
    // stripper deleted NBSP outright, so "260<NBSP>351" became an accepted
    // "260351": a corrupted value quietly turned into a plausible one, and AP
    // parses this field off the PDF. Consolidating onto lib/sanitize folds NBSP
    // to a space instead, so this now fails closed and Robin retypes it.
    expect(sanitizePoNumber('260\u00a0351').ok).toBe(false)
    expect(sanitizePoNumber('260 351').ok).toBe(false)
    expect(sanitizePoNumber('26035').ok).toBe(false)
    expect(sanitizePoNumber('26035A').ok).toBe(false)
    expect(sanitizePoNumber('').ok).toBe(false)
    expect(sanitizePoNumber('000351')).toEqual({ ok: true, value: '000351' })
  })
  it('env list splits and sanitizes', () => {
    process.env.__TEST_CC = '\ufeffrobin.graham@ilovesalt.com, nb@ilovesalt.com'
    expect(envAddressListOr('__TEST_CC', '')).toEqual(['robin.graham@ilovesalt.com', 'nb@ilovesalt.com'])
  })
})

describe('P1-10 NS rate', () => {
  it('is 14%', () => {
    expect(computeHst(100, 'NS')).toBe(14)
    expect(computeHst(100, 'ON')).toBe(13)
    expect(computeHst(100, 'NB')).toBe(15)
  })
})
