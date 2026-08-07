import { describe, it, expect } from 'vitest'
import { upsertDraftInvoice } from '../lib/draft-invoice'

type Row = Record<string, any>

function fakeDb(opts: {
  bams?: Row[]; cohorts?: Row[]; receipts?: Row[]; ledger?: Row[]; invoices?: Row[]
  banking?: Row | null; bankingError?: string; insertError?: string
}) {
  const tables: Record<string, Row[]> = {
    bams: opts.bams ?? [], cohorts: opts.cohorts ?? [], receipts: opts.receipts ?? [],
    reimbursement_ledger: opts.ledger ?? [], invoices: opts.invoices ?? [], admin_notifications: []
  }
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
        if (api._mode === 'insert') {
          if (table === 'invoices' && opts.insertError) return { data: null, error: { message: opts.insertError } }
          const row = { id: 'newid', ...api._payload }
          rows.push(row)
          return { data: [row], error: null }
        }
        const matched = rows.filter(r => filters.every(f => f(r)))
        if (api._mode === 'update') {
          matched.forEach(r => Object.assign(r, api._payload))
          return { data: matched, error: null }
        }
        return { data: matched, error: null }
      }
    }
    return api
  }
  return {
    _tables: tables,
    from: (t: string) => q(t),
    rpc: async () => opts.bankingError
      ? { data: null, error: { message: opts.bankingError } }
      : { data: opts.banking === undefined ? [] : (opts.banking ? [opts.banking] : []), error: null }
  }
}

const BAM = { id: 'b1', cohort_id: 'c1', first_name: 'Lucas', last_name: 'Grabowski', email: 'l@x.com', phone: '416', street: '1 St', city: 'Toronto', prov: 'ON', postal: 'M6K', bank_name: 'RBC', initials_resolved: 'LG' }
const COHORT = { id: 'c1', program_label: 'BUD LIGHT U', po_number: '260351', salary_default: '218.75' }
const BANKING = { institution_no: '003', transit_no: '00123', account_no: '0000456789', hst_number: null }

describe('P0-D · amount comes from the ledger, not from a recount', () => {
  it('uses paid_cad even when receipts sum above the old hardcoded 150', async () => {
    const db: any = fakeDb({
      bams: [BAM], cohorts: [COHORT], banking: BANKING,
      receipts: [{ id: 'r1', bam_id: 'b1', period: '2026-09-01', status: 'approved', bud_light_total_incl_tax: '400.00' }],
      ledger: [{ bam_id: 'b1', cohort_id: 'c1', period: '2026-09-01', paid_cad: '100.00' }]
    })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(r.ok).toBe(true)
    const inv = db._tables.invoices[0]
    expect(inv.payload_json.lines.find((l: any) => /Reimbursement/.test(l.description)).total).toBe(100)
    expect(inv.payload_json.subtotal).toBe(318.75)
    expect(inv.invoice_number).toBe('INV-LG1')
  })

  it('blocks when the ledger row is missing but receipts exist', async () => {
    const db: any = fakeDb({
      bams: [BAM], cohorts: [COHORT], banking: BANKING,
      receipts: [{ id: 'r1', bam_id: 'b1', period: '2026-09-01', status: 'approved' }],
      ledger: []
    })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(r.ok).toBe(false)
    expect((r as any).reason).toMatch(/no reimbursement_ledger row/)
    expect(db._tables.invoices.length).toBe(0)
  })

  it('salary-only invoice when there are no receipts at all', async () => {
    const db: any = fakeDb({ bams: [BAM], cohorts: [COHORT], banking: BANKING, receipts: [], ledger: [] })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(r.ok).toBe(true)
    expect(db._tables.invoices[0].payload_json.lines.length).toBe(1)
    expect(db._tables.invoices[0].payload_json.total).toBe(218.75)
  })
})

describe('P0-E · no invoice with blank banking', () => {
  it('blocks when decrypt returns nothing', async () => {
    const db: any = fakeDb({ bams: [BAM], cohorts: [COHORT], banking: null, ledger: [{ bam_id: 'b1', cohort_id: 'c1', period: '2026-09-01', paid_cad: '10' }] })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(r.ok).toBe(false)
    expect((r as any).reason).toMatch(/banking details are missing/)
    expect(db._tables.invoices.length).toBe(0)
  })
  it('blocks when decrypt errors', async () => {
    const db: any = fakeDb({ bams: [BAM], cohorts: [COHORT], bankingError: 'pgsodium key missing' })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(r.ok).toBe(false)
    expect((r as any).reason).toMatch(/decrypt_bam_banking failed/)
  })
  it('blocks on a partial banking row', async () => {
    const db: any = fakeDb({ bams: [BAM], cohorts: [COHORT], banking: { institution_no: '003', transit_no: '', account_no: '' } })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(r.ok).toBe(false)
  })
})

describe('P0-H · write failures are surfaced', () => {
  it('reports an invoice-number collision instead of silently skipping the month', async () => {
    const db: any = fakeDb({
      bams: [BAM], cohorts: [COHORT], banking: BANKING, ledger: [], receipts: [],
      insertError: 'duplicate key value violates unique constraint "invoices_number_all_uniq"'
    })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(r.ok).toBe(false)
    expect((r as any).reason).toMatch(/invoice insert failed/)
    expect((r as any).reason).toMatch(/invoices_number_all_uniq/)
  })
  it('blocks when po_number is missing', async () => {
    const db: any = fakeDb({ bams: [BAM], cohorts: [{ ...COHORT, po_number: null }], banking: BANKING })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect((r as any).reason).toMatch(/po_number/)
  })
  it('refuses a cross-cohort invoice', async () => {
    const db: any = fakeDb({ bams: [{ ...BAM, cohort_id: 'other' }], cohorts: [COHORT], banking: BANKING })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect((r as any).reason).toMatch(/belongs to cohort/)
  })
  it('will not rewrite an invoice that is already sent', async () => {
    const db: any = fakeDb({
      bams: [BAM], cohorts: [COHORT], banking: BANKING, ledger: [], receipts: [],
      invoices: [{ id: 'i1', bam_id: 'b1', cohort_id: 'c1', period: '2026-09-01', seq: 1, revision: 1, invoice_number: 'INV-LG1', status: 'sent' }]
    })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(r.ok).toBe(false)
    expect((r as any).reason).toMatch(/already sent/)
  })
})

describe('P1-8 · no INV-AUNDEFINED', () => {
  it('an empty last name yields a valid number', async () => {
    const db: any = fakeDb({
      bams: [{ ...BAM, first_name: 'Ana', last_name: '', initials_resolved: null }],
      cohorts: [COHORT], banking: BANKING, ledger: [], receipts: []
    })
    const r = await upsertDraftInvoice(db, 'b1', 'c1', '2026-09-01')
    expect(r.ok).toBe(true)
    expect((r as any).invoiceNumber).toMatch(/^INV-[A-Z]{2,10}1$/)
    expect((r as any).invoiceNumber).not.toMatch(/UNDEFINED/)
  })
})
