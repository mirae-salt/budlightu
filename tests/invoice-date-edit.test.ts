/**
 * An admin can choose the printed date, inside the month, and a rebuild keeps it.
 *
 * Lea Major's September invoice was created on the 30th. The default 16th would print a date
 * two weeks before the invoice existed, and AP may count net-15 from the printed date.
 */
import { describe, it, expect } from 'vitest'
import { parseInvoiceDateEdit } from '../lib/invoice-date-edit'
import { readableInvoiceDate } from '../lib/invoice-payload'
import { upsertDraftInvoice } from '../lib/draft-invoice'
import { applyInvoiceLineEdit } from '../lib/invoice-lines'

const TODAY = new Date('2026-09-30T18:00:00Z')

describe('parseInvoiceDateEdit', () => {
  it('nothing sent leaves the date alone', () => {
    for (const raw of [undefined, null, '']) {
      expect(parseInvoiceDateEdit(raw, '2026-09-01', TODAY)).toEqual({ ok: true, provided: false })
    }
  })

  it('accepts the 30th for September and prints it as the invoice does', () => {
    const r = parseInvoiceDateEdit('2026-09-30', '2026-09-01', TODAY)
    expect(r).toMatchObject({ ok: true, provided: true, readable: 'SEPTEMBER 30TH, 2026', iso: '2026-09-30T12:00:00.000Z' })
  })

  it.each([
    ['2026-09-01', 'SEPTEMBER 1ST, 2026'],
    ['2026-09-02', 'SEPTEMBER 2ND, 2026'],
    ['2026-09-03', 'SEPTEMBER 3RD, 2026'],
    ['2026-09-11', 'SEPTEMBER 11TH, 2026'],
    ['2026-09-22', 'SEPTEMBER 22ND, 2026']
  ])('ordinal for %s', (d, readable) => {
    expect(readableInvoiceDate(new Date(`${d}T12:00:00Z`))).toBe(readable)
  })

  it('refuses another month, so a September invoice is still dated September', () => {
    const r = parseInvoiceDateEdit('2026-10-01', '2026-09-01', TODAY)
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect((r as { message: string }).message).toContain('September 2026')
  })

  it('refuses the future', () => {
    const r = parseInvoiceDateEdit('2026-09-30', '2026-09-01', new Date('2026-09-20T12:00:00Z'))
    expect(r).toMatchObject({ ok: false, message: 'An invoice cannot be dated in the future.' })
  })

  it.each(['30/09/2026', '2026-9-30', 'yesterday', '2026-02-31', '2026-09-31'])('refuses "%s"', raw => {
    expect(parseInvoiceDateEdit(raw, '2026-09-01', TODAY).ok).toBe(false)
  })
})

// ── the editor and the rebuild, on a fake database ───────────────────────────────────────

type Row = Record<string, any>
function fakeDb(tables: Record<string, Row[]>, banking?: Row) {
  function q(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    const api: any = {
      _mode: 'select', _payload: null as any,
      select() { return api },
      insert(p: Row) { api._mode = 'insert'; api._payload = p; return api },
      update(p: Row) { api._mode = 'update'; api._payload = p; return api },
      eq(c: string, v: any) { filters.push(r => String(r[c]) === String(v)); return api },
      is(c: string, v: any) { filters.push(r => (v === null ? r[c] == null : r[c] === v)); return api },
      in(c: string, vs: any[]) { filters.push(r => vs.includes(r[c])); return api },
      order() { return api }, limit() { return api }, neq() { return api },
      then(res: any, rej: any) { return api._run().then(res, rej) },
      async _run() {
        const rows = tables[table] ?? (tables[table] = [])
        if (api._mode === 'insert') { const row = { id: `new-${rows.length}`, ...api._payload }; rows.push(row); return { data: [row], error: null } }
        const matched = rows.filter(r => filters.every(f => f(r)))
        if (api._mode === 'update') matched.forEach(r => Object.assign(r, api._payload))
        return { data: matched, error: null }
      }
    }
    return api
  }
  return { from: (t: string) => q(t), rpc: async () => ({ data: banking ? [banking] : [], error: null }) }
}

const BAM = { id: 'b1', cohort_id: 'c1', first_name: 'Lea', last_name: 'Major', email: 'l@x.com', phone: '416', street: '1 St', city: 'Toronto', prov: 'ON', postal: 'M6K 1A1', bank_name: 'RBC', initials_resolved: 'LMA' }
const COHORT = { id: 'c1', program_label: 'BUD LIGHT U', po_number: '260351', salary_default: '218.75' }
const BANKING = { institution_no: '003', transit_no: '00123', account_no: '0000456789', hst_number: null }

describe('a chosen date survives', () => {
  it('saved on a draft, then kept when the draft is rebuilt', async () => {
    const tables: Record<string, Row[]> = { bams: [BAM], cohorts: [COHORT], receipts: [], reimbursement_ledger: [], invoices: [], admin_notifications: [] }
    const db: any = fakeDb(tables, BANKING)

    // First build: the 16th, as the rule says.
    const first = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(first.ok).toBe(true)
    expect(tables.invoices[0].payload_json.invoiceDate.slice(0, 10)).toBe('2026-09-16')
    expect(tables.invoices[0].payload_json.invoiceDateCustom).toBeUndefined()

    // An admin picks the 30th (Edit, date only, lines as they are).
    const inv = tables.invoices[0]
    const lines = inv.payload_json.lines.map((l: any) => ({ description: l.description, qty: String(l.qty), unitPrice: String(l.unitPrice) }))
    const edit = await applyInvoiceLineEdit(db, {
      invoiceId: inv.id, lines, reason: 'Created on the 30th for a closed month',
      invoiceDate: '2026-09-30', actor: { userId: null, role: 'admin' }, hstOnFile: false, province: 'ON'
    })
    expect(edit.ok).toBe(true)
    expect(tables.invoices[0].payload_json.invoiceDate.slice(0, 10)).toBe('2026-09-30')
    expect(tables.invoices[0].payload_json.footer.dateReadable).toBe('SEPTEMBER 30TH, 2026')
    expect(tables.invoices[0].payload_json.invoiceDateCustom).toBe(true)
    expect(tables.invoices[0].pdf_key).toBeNull()

    // The student finishes onboarding, or a receipt changes: the draft is rebuilt.
    const again = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(again.ok).toBe(true)
    expect(tables.invoices.length).toBe(1)
    expect(tables.invoices[0].payload_json.invoiceDate.slice(0, 10)).toBe('2026-09-30')
    expect(tables.invoices[0].payload_json.footer.dateReadable).toBe('SEPTEMBER 30TH, 2026')
  })

  it('an edit that does not touch the date never re-stamps it', async () => {
    const tables: Record<string, Row[]> = { bams: [BAM], cohorts: [COHORT], receipts: [], reimbursement_ledger: [], invoices: [], admin_notifications: [] }
    const db: any = fakeDb(tables, BANKING)
    await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    const inv = tables.invoices[0]
    const lines = inv.payload_json.lines.map((l: any) => ({ description: l.description, qty: String(l.qty), unitPrice: String(l.unitPrice) }))
    await applyInvoiceLineEdit(db, { invoiceId: inv.id, lines, reason: 'Checking nothing moves', actor: { userId: null, role: 'admin' }, hstOnFile: false, province: 'ON' })
    expect(tables.invoices[0].payload_json.invoiceDate.slice(0, 10)).toBe('2026-09-16')
    expect(tables.invoices[0].payload_json.invoiceDateCustom).toBeUndefined()
  })

  it('refuses a date outside the invoice month and saves nothing', async () => {
    const tables: Record<string, Row[]> = { bams: [BAM], cohorts: [COHORT], receipts: [], reimbursement_ledger: [], invoices: [], admin_notifications: [] }
    const db: any = fakeDb(tables, BANKING)
    await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    const inv = tables.invoices[0]
    const lines = inv.payload_json.lines.map((l: any) => ({ description: l.description, qty: String(l.qty), unitPrice: String(l.unitPrice) }))
    const edit = await applyInvoiceLineEdit(db, { invoiceId: inv.id, lines, reason: 'Wrong month on purpose', invoiceDate: '2026-10-02', actor: { userId: null, role: 'admin' }, hstOnFile: false, province: 'ON' })
    expect(edit.ok).toBe(false)
    expect(tables.invoices[0].payload_json.invoiceDate.slice(0, 10)).toBe('2026-09-16')
  })
})
