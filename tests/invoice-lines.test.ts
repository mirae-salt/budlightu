/**
 * In-app invoice line editing (lib/invoice-lines.ts).
 *
 * The money rules under test, in order of how much damage they prevent:
 *  1. the reimbursement line cannot be touched here — it is the subject of the
 *     send-time hard block (payloadLedgerMismatch) and its truth source is the
 *     receipt, not the invoice
 *  2. subtotal / tax / total are recomputed server-side; a client-sent figure is
 *     ignored entirely
 *  3. tax only when the BAM has an HST number, mirroring generateInvoicePayload
 *  4. per-line and per-invoice ceilings so a typo cannot produce a five-figure
 *     invoice
 *  5. 'sent' / 'paid' / 'void' are not editable (AP already holds the document)
 *  6. descriptions are sanitized (they reach a PDF and an email to AP)
 *  7. pdf_key is invalidated, or the next send attaches the pre-edit document
 */
import { describe, it, expect } from 'vitest'
import {
  applyInvoiceLineEdit,
  parseInvoiceLines,
  recomputeTotals,
  reimbursementEditProblem,
  resolveHstApplicable,
  isReimbursementLine,
  parseEditReason,
  MAX_LINE_TOTAL,
  MAX_INVOICE_TOTAL
} from '../lib/invoice-lines'
import { reimbursementLineTotal, payloadLedgerMismatch } from '../lib/invoice-ledger'
import { generateInvoicePayload } from '../lib/invoice-payload'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const SALARY_DESC = 'Brand Activation Manager monthly payment (September Payment)'
const REIMB_DESC = 'Reimbursement for sponsorship allowance (September)'

function payload(over: Row = {}): Row {
  return {
    invoiceNumber: 'INV-TB1',
    influencer: { name: 'Test Bam', street: '1 King St', cityProvPostal: 'Toronto, ON, M6K 1Z5', email: 'a@b.ca', phone: '416' },
    directDeposit: { bank: 'RBC', institutionNumber: '003', transitNumber: '00123', accountNumber: '0000456789', email: 'a@b.ca' },
    lines: [
      { qty: 1, description: SALARY_DESC, unitPrice: 218.75, total: 218.75 },
      { qty: 1, description: REIMB_DESC, unitPrice: 112.4, total: 112.4 }
    ],
    subtotal: 331.15,
    tax: 0,
    total: 331.15,
    currency: 'CAD',
    ...over
  }
}

/**
 * Minimal supabase-js stand-in: chainable, returns { data, error }, never throws
 * (ENGINEERING-RULES 7.1). Records storage removals so pdf invalidation is
 * observable.
 */
function fakeDb(opts: {
  invoice?: Row | null
  readError?: string
  updateError?: string
  auditError?: string
  removeError?: string
  /** simulate a concurrent status change between the read and the write */
  statusRaceTo?: string
} = {}) {
  const invoices: Row[] = opts.invoice === null ? [] : [opts.invoice ?? {
    id: 'inv1', invoice_number: 'INV-TB1', status: 'draft', period: '2026-09-01',
    payload_json: payload(), pdf_key: '2026-09/INV-TB1.pdf'
  }]
  const audit: Row[] = []
  const removed: string[][] = []

  function q(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      _mode: 'select', _payload: null as Row | null,
      select() { return api },
      insert(p: Row) { api._mode = 'insert'; api._payload = p; return api },
      update(p: Row) { api._mode = 'update'; api._payload = p; return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eq(c: string, v: any) { filters.push(r => String(r[c]) === String(v)); return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      in(c: string, vs: any[]) { filters.push(r => vs.includes(r[c])); return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then(res: any, rej: any) { return api._run().then(res, rej) },
      async _run() {
        const rows = table === 'invoices' ? invoices : audit
        if (api._mode === 'insert') {
          if (table === 'audit_log' && opts.auditError) return { data: null, error: { message: opts.auditError } }
          rows.push({ id: `a${rows.length + 1}`, ...api._payload })
          return { data: [rows[rows.length - 1]], error: null }
        }
        if (api._mode === 'select' && table === 'invoices' && opts.readError) {
          return { data: null, error: { message: opts.readError } }
        }
        if (api._mode === 'update' && opts.updateError) {
          return { data: null, error: { message: opts.updateError } }
        }
        if (api._mode === 'update' && opts.statusRaceTo) {
          // The row moved on. The status predicate now excludes it.
          for (const r of rows) r.status = opts.statusRaceTo
        }
        const matched = rows.filter(r => filters.every(f => f(r)))
        if (api._mode === 'update') {
          for (const r of matched) Object.assign(r, api._payload)
          return { data: matched.map(r => ({ ...r })), error: null }
        }
        // Copies, like a real driver. Returning live references would let the lib
        // read a value the update has already changed and hide that bug.
        return { data: matched.map(r => ({ ...r })), error: null }
      }
    }
    return api
  }

  return {
    from: (t: string) => q(t),
    storage: {
      from: () => ({
        async remove(keys: string[]) {
          if (opts.removeError) return { data: null, error: { message: opts.removeError } }
          removed.push(keys)
          return { data: keys, error: null }
        }
      })
    },
    _invoices: invoices,
    _audit: audit,
    _removed: removed
  }
}

const REASON = 'Robin approved a $60 bar tab for the Sept 12 event'
const NO_HST = { hstOnFile: false, province: 'ON' }

function edit(db: ReturnType<typeof fakeDb>, lines: unknown, over: Record<string, unknown> = {}) {
  return applyInvoiceLineEdit(db, {
    invoiceId: 'inv1',
    lines,
    reason: REASON,
    actor: { userId: 'u1', role: 'program_admin' },
    ...NO_HST,
    ...over
  })
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the reimbursement line is off limits', () => {
  const before = payload().lines

  it('refuses a changed reimbursement amount and names the receipt queue', async () => {
    const db = fakeDb()
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 218.75 },
      { description: REIMB_DESC, qty: 1, unitPrice: 150 }
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(409)
    expect(res.message).toMatch(/\/admin\/receipts/)
    expect(res.message).toMatch(/\$112\.40 to \$150\.00/)
    // Nothing was written.
    expect(db._invoices[0].payload_json.total).toBe(331.15)
    expect(db._audit).toHaveLength(0)
  })

  it('refuses a SECOND reimbursement line', async () => {
    const db = fakeDb()
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 218.75 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 },
      { description: 'Reimbursement for extra receipts', qty: 1, unitPrice: 40 }
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toMatch(/only one reimbursement line/i)
    expect(db._audit).toHaveLength(0)
  })

  it('refuses a reimbursement line added to a salary-only invoice', () => {
    const problem = reimbursementEditProblem(
      [{ description: SALARY_DESC, total: 218.75 }],
      [
        { qty: 1, description: SALARY_DESC, unitPrice: 218.75, total: 218.75 },
        { qty: 1, description: 'reimbursement (manual)', unitPrice: 0, total: 0 }
      ]
    )
    // Note the added line totals $0, so the ledger comparison alone would NOT
    // catch it. The count check does.
    expect(problem).toMatch(/cannot be added/i)
  })

  it('refuses removing the reimbursement line', () => {
    expect(reimbursementEditProblem(before, [
      { qty: 1, description: SALARY_DESC, unitPrice: 218.75, total: 218.75 }
    ])).toMatch(/cannot be removed/i)
  })

  it('refuses renaming it even when the total is unchanged', () => {
    expect(reimbursementEditProblem(before, [
      { qty: 1, description: SALARY_DESC, unitPrice: 218.75, total: 218.75 },
      { qty: 1, description: 'Reimbursement for sponsorship allowance (October)', unitPrice: 112.4, total: 112.4 }
    ])).toMatch(/read-only/i)
  })

  it('allows salary and ad-hoc edits that leave it alone', () => {
    expect(reimbursementEditProblem(before, [
      { qty: 1, description: SALARY_DESC, unitPrice: 250, total: 250 },
      { qty: 1, description: REIMB_DESC, unitPrice: 112.4, total: 112.4 },
      { qty: 2, description: 'Event gas, approved by Robin', unitPrice: 30, total: 60 }
    ])).toBeNull()
  })

  it('uses the same predicate as the send-time ledger check', () => {
    // If these two ever disagree about which line is the reimbursement, the hard
    // block stops protecting the amount.
    const lines = [
      { qty: 1, description: SALARY_DESC, unitPrice: 1, total: 1 },
      { qty: 1, description: REIMB_DESC, unitPrice: 5, total: 5 },
      { qty: 1, description: 'REIMBURSEMENT (uppercase)', unitPrice: 7, total: 7 }
    ]
    const flagged = lines.filter(isReimbursementLine)
    expect(reimbursementLineTotal(lines)).toBe(flagged.reduce((s, l) => s + l.total, 0))
  })

  it('an allowed edit keeps payloadLedgerMismatch passing', async () => {
    const db = fakeDb()
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 250 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 },
      { description: 'Event bar tab, approved by Robin', qty: 1, unitPrice: 60 }
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The ledger still says 112.40 and the invoice still says 112.40.
    expect(payloadLedgerMismatch(res.lines, 112.4)).toBeNull()
    expect(res.total).toBe(422.4)
  })
})

describe('totals are recomputed server-side', () => {
  it('ignores a client-sent line total and a client-sent invoice total', async () => {
    const db = fakeDb()
    const res = await edit(db, [
      // Every hostile figure a client could send: a wrong line total, and a
      // top-level total on the line object.
      { description: SALARY_DESC, qty: 1, unitPrice: 218.75, total: 1, subtotal: 0 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4, total: 99999 }
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.lines[0].total).toBe(218.75)
    expect(res.lines[1].total).toBe(112.4)
    expect(res.subtotal).toBe(331.15)
    expect(res.total).toBe(331.15)
    expect(db._invoices[0].payload_json.total).toBe(331.15)
  })

  it('recomputes qty * unitPrice and rounds to cents', () => {
    const parsed = parseInvoiceLines([{ description: 'Event staffing', qty: '3', unitPrice: '33.335' }])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.lines[0].unitPrice).toBe(33.34)   // parseMoney rounds to cents first
    expect(parsed.lines[0].total).toBe(100.02)
  })

  it('accepts money as strings from a form input', () => {
    const parsed = parseInvoiceLines([{ description: 'Bar tab', qty: 1, unitPrice: '$1,200.50' }])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.lines[0].unitPrice).toBe(1200.5)
  })

  it('rejects junk amounts instead of coercing them to 0', () => {
    for (const bad of ['', 'abc', null, undefined, NaN, Infinity, {}]) {
      const r = parseInvoiceLines([{ description: 'Bar tab', qty: 1, unitPrice: bad }])
      expect(r.ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('rejects a fractional or zero quantity', () => {
    expect(parseInvoiceLines([{ description: 'Bar tab', qty: '1.5', unitPrice: 10 }]).ok).toBe(false)
    expect(parseInvoiceLines([{ description: 'Bar tab', qty: 0, unitPrice: 10 }]).ok).toBe(false)
    expect(parseInvoiceLines([{ description: 'Bar tab', qty: -1, unitPrice: 10 }]).ok).toBe(false)
  })

  it('rejects a negative unit price', () => {
    const r = parseInvoiceLines([{ description: 'Clawback', qty: 1, unitPrice: -50 }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/negative/i)
  })

  it('matches generateInvoicePayload for the same lines', () => {
    const generated = generateInvoicePayload({
      bam: {
        firstName: 'Test', lastName: 'Bam', street: '1 King St', city: 'Toronto', prov: 'ON', postal: 'M6K1Z5',
        email: 'a@b.ca', phone: '416', bankName: 'RBC',
        institutionNo: '003', transitNo: '00123', accountNo: '0000456789',
        hstNumber: null, initialsResolved: 'TB'
      },
      cohort: { programLabel: 'BLU', poNumber: '260351', salaryDefault: 218.75, currency: 'CAD' },
      ledger: { paidCad: 112.4 },
      period: new Date('2026-09-01T00:00:00Z'),
      seq: 1,
      generatedAt: new Date('2026-09-16T00:00:00Z')
    })
    const recomputed = recomputeTotals(
      generated.lines.map(l => ({ ...l })),
      { hstApplicable: false, province: 'ON' }
    )
    expect(recomputed.ok).toBe(true)
    if (!recomputed.ok) return
    expect(recomputed.subtotal).toBe(generated.subtotal)
    expect(recomputed.tax).toBe(generated.tax)
    expect(recomputed.total).toBe(generated.total)
  })
})

describe('tax applies only when the BAM has an HST number', () => {
  const line = [{ qty: 1, description: SALARY_DESC, unitPrice: 100, total: 100 }]

  it('no HST number: tax is 0 whatever the province', () => {
    for (const prov of ['ON', 'NS', 'AB']) {
      const r = recomputeTotals(line, { hstApplicable: false, province: prov })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.tax).toBe(0)
      expect(r.total).toBe(100)
    }
  })

  it('HST number: the province rate is applied', () => {
    const on = recomputeTotals(line, { hstApplicable: true, province: 'ON' })
    expect(on.ok && on.tax).toBe(13)
    const ns = recomputeTotals(line, { hstApplicable: true, province: 'NS' })
    expect(ns.ok && ns.tax).toBe(14)   // 14% since 2025-04-01
    const ab = recomputeTotals(line, { hstApplicable: true, province: 'AB' })
    expect(ab.ok && ab.tax).toBe(5)
  })

  it('an unknown province is refused, not defaulted', () => {
    const r = recomputeTotals(line, { hstApplicable: true, province: 'XX' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/Unknown province/)
  })

  it('end to end: an HST invoice keeps charging tax on the new subtotal', async () => {
    const db = fakeDb({
      invoice: {
        id: 'inv1', invoice_number: 'INV-TB1', status: 'draft', period: '2026-09-01',
        pdf_key: null,
        payload_json: payload({ subtotal: 331.15, tax: 43.05, total: 374.2 })
      }
    })
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 250 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 }
    ], { hstOnFile: true, province: 'ON' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.subtotal).toBe(362.4)
    expect(res.tax).toBe(47.11)
    expect(res.total).toBe(409.51)
  })

  it('refuses the edit when HST status changed after generation', () => {
    // Invoice has no tax but the roster now has an HST number.
    const a = resolveHstApplicable({ hstOnFile: true, storedSubtotal: 331.15, storedTax: 0 })
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.message).toMatch(/now has an HST number/)

    // Invoice charges tax but the number is gone.
    const b = resolveHstApplicable({ hstOnFile: false, storedSubtotal: 331.15, storedTax: 43.05 })
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.message).toMatch(/no longer has an HST number/)

    // Agreement in both directions is fine.
    expect(resolveHstApplicable({ hstOnFile: false, storedSubtotal: 331.15, storedTax: 0 }))
      .toEqual({ ok: true, hstApplicable: false })
    expect(resolveHstApplicable({ hstOnFile: true, storedSubtotal: 331.15, storedTax: 43.05 }))
      .toEqual({ ok: true, hstApplicable: true })
  })
})

describe('ceilings so a typo cannot produce a five-figure invoice', () => {
  it('rejects a per-line total over the limit', async () => {
    const db = fakeDb()
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 218.75 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 },
      { description: 'Event costs', qty: 1, unitPrice: 21875 }   // fat-fingered salary
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(400)
    expect(res.message).toMatch(new RegExp(`\\$${MAX_LINE_TOTAL.toFixed(2)} per line limit`))
    expect(db._invoices[0].payload_json.total).toBe(331.15)
  })

  it('rejects qty * unitPrice over the per-line limit even when both look sane', () => {
    const r = parseInvoiceLines([{ description: 'Event staffing', qty: 50, unitPrice: 100 }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/per line limit/)
  })

  it('rejects an invoice total over the per-invoice limit', () => {
    const lines = [1900, 1900, 1900].map((p, i) => ({
      qty: 1, description: `Ad-hoc ${i + 1}`, unitPrice: p, total: p
    }))
    const r = recomputeTotals(lines, { hstApplicable: false, province: 'ON' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(new RegExp(`over the \\$${MAX_INVOICE_TOTAL.toFixed(2)} limit`))
  })

  it('counts tax towards the per-invoice limit', () => {
    const lines = [{ qty: 1, description: 'Ad-hoc', unitPrice: 1900, total: 1900 }]
    const ok = recomputeTotals([...lines, { qty: 1, description: 'Ad-hoc 2', unitPrice: 1900, total: 1900 }, { qty: 1, description: 'Ad-hoc 3', unitPrice: 1000, total: 1000 }], { hstApplicable: false, province: 'ON' })
    expect(ok.ok).toBe(true)   // 4800 subtotal, no tax
    const withTax = recomputeTotals([...lines, { qty: 1, description: 'Ad-hoc 2', unitPrice: 1900, total: 1900 }, { qty: 1, description: 'Ad-hoc 3', unitPrice: 1000, total: 1000 }], { hstApplicable: true, province: 'ON' })
    expect(withTax.ok).toBe(false)   // 4800 + 624 = 5424
  })

  it('caps the number of lines', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ description: `Line ${i}`, qty: 1, unitPrice: 1 }))
    expect(parseInvoiceLines(many).ok).toBe(false)
    expect(parseInvoiceLines([]).ok).toBe(false)
    expect(parseInvoiceLines('nope').ok).toBe(false)
  })
})

describe('only draft and approved are editable', () => {
  for (const status of ['sent', 'paid'] as const) {
    it(`refuses ${status} and says to void and reissue`, async () => {
      const db = fakeDb({
        invoice: {
          id: 'inv1', invoice_number: 'INV-TB1', status, period: '2026-09-01',
          payload_json: payload(), pdf_key: '2026-09/INV-TB1.pdf'
        }
      })
      const res = await edit(db, [{ description: SALARY_DESC, qty: 1, unitPrice: 250 }])
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.status).toBe(409)
      expect(res.message).toMatch(/AP already holds/)
      expect(res.message).toMatch(/Void it and reissue/)
      expect(db._invoices[0].payload_json.total).toBe(331.15)
      expect(db._invoices[0].pdf_key).toBe('2026-09/INV-TB1.pdf')
    })
  }

  it('refuses void', async () => {
    const db = fakeDb({
      invoice: {
        id: 'inv1', invoice_number: 'INV-TB1', status: 'void', period: '2026-09-01',
        payload_json: payload(), pdf_key: null
      }
    })
    const res = await edit(db, [{ description: SALARY_DESC, qty: 1, unitPrice: 250 }])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toMatch(/is void/)
  })

  it('allows approved, and warns that earlier copies are stale', async () => {
    const db = fakeDb({
      invoice: {
        id: 'inv1', invoice_number: 'INV-TB1', status: 'approved', period: '2026-09-01',
        payload_json: payload(), pdf_key: '2026-09/INV-TB1.pdf'
      }
    })
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 250 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 }
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.warnings.join(' ')).toMatch(/batch approval/)
  })

  it('refuses when the status changed between the read and the write', async () => {
    const db = fakeDb({ statusRaceTo: 'sent' })
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 250 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 }
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(409)
    expect(res.message).toMatch(/changed while it was being edited/)
  })
})

describe('description sanitizing', () => {
  // Built from NUMERIC code points on purpose (ENGINEERING-RULES 7.6): a literal
  // U+FEFF pasted into a source file cannot be reviewed by eye, and that exact
  // character is what this project already shipped once.
  const BOM = String.fromCodePoint(0xfeff)
  const ZWSP = String.fromCodePoint(0x200b)
  const NBSP = String.fromCodePoint(0x00a0)
  const HAN = String.fromCodePoint(0x5f20) + String.fromCodePoint(0x4f1f)

  it('strips invisible characters and collapses whitespace', async () => {
    const db = fakeDb()
    const dirty = BOM + 'Event' + ZWSP + ' bar' + NBSP + 'tab   approved '
    const res = await edit(db, [
      { description: dirty, qty: 1, unitPrice: 60 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 }
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.lines[0].description).toBe('Event bar tab approved')
    for (const bad of [BOM, ZWSP, NBSP]) {
      expect(res.lines[0].description.includes(bad)).toBe(false)
    }
    // And what was STORED is the clean value, not the value that was typed.
    expect(db._invoices[0].payload_json.lines[0].description).toBe('Event bar tab approved')
  })

  it('rejects a description the invoice font cannot print, at edit time', async () => {
    const db = fakeDb()
    const res = await edit(db, [
      { description: 'Bar tab ' + HAN, qty: 1, unitPrice: 60 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 }
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toMatch(/cannot print/)
    // Rejected BEFORE the write, so the send is not what discovers it.
    expect(db._invoices[0].payload_json.total).toBe(331.15)
    expect(db._invoices[0].pdf_key).toBe('2026-09/INV-TB1.pdf')
  })

  it('rejects an empty or whitespace-only description', () => {
    expect(parseInvoiceLines([{ description: '   ', qty: 1, unitPrice: 10 }]).ok).toBe(false)
    expect(parseInvoiceLines([{ description: ZWSP, qty: 1, unitPrice: 10 }]).ok).toBe(false)
    expect(parseInvoiceLines([{ description: 'x'.repeat(121), qty: 1, unitPrice: 10 }]).ok).toBe(false)
  })
})

describe('a money change needs a reason', () => {
  it('refuses a missing or thin reason', () => {
    expect(parseEditReason(undefined).ok).toBe(false)
    expect(parseEditReason('').ok).toBe(false)
    expect(parseEditReason('typo').ok).toBe(false)
    expect(parseEditReason('x'.repeat(501)).ok).toBe(false)
    expect(parseEditReason('  Robin approved the bar tab  ')).toEqual({ ok: true, reason: 'Robin approved the bar tab' })
  })

  it('the route path refuses before reading anything', async () => {
    const db = fakeDb()
    const res = await applyInvoiceLineEdit(db, {
      invoiceId: 'inv1',
      lines: [{ description: SALARY_DESC, qty: 1, unitPrice: 250 }],
      reason: '',
      actor: { userId: 'u1', role: 'program_admin' },
      ...NO_HST
    })
    expect(res.ok).toBe(false)
    expect(db._invoices[0].payload_json.total).toBe(331.15)
  })
})

describe('pdf_key invalidation and audit', () => {
  it('clears pdf_key and deletes the stale object', async () => {
    const db = fakeDb()
    expect(db._invoices[0].pdf_key).toBe('2026-09/INV-TB1.pdf')
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 250 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 }
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // This is the detail that decides whether AP gets the new document or the old
    // one: ensureInvoicePdf reuses the stored object whenever pdf_key is set.
    expect(db._invoices[0].pdf_key).toBeNull()
    expect(res.pdfInvalidated).toBe(true)
    expect(db._removed).toEqual([['2026-09/INV-TB1.pdf']])
  })

  it('still succeeds, with a warning, when the stored object cannot be deleted', async () => {
    const db = fakeDb({ removeError: 'bucket not found' })
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 250 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 }
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(db._invoices[0].pdf_key).toBeNull()
    expect(res.warnings.join(' ')).toMatch(/could not be deleted/)
  })

  it('writes audit_log in the real column shape, with before and after', async () => {
    const db = fakeDb()
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 250 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 }
    ])
    expect(res.ok).toBe(true)
    const row = db._audit[0]
    expect(row.action).toBe('invoice_lines_edit')
    expect(row.entity).toBe('invoices')
    expect(row.entity_id).toBe('inv1')
    expect(row.actor_id).toBe('u1')
    expect(row.actor_role).toBe('program_admin')
    // There is no `meta` column; a wrong shape fails silently.
    expect(Object.keys(row).sort()).toEqual(
      ['action', 'actor_id', 'actor_role', 'after_json', 'before_json', 'entity', 'entity_id', 'id'].sort()
    )
    expect(row.before_json.total).toBe(331.15)
    expect(row.after_json.total).toBe(362.4)
    expect(row.after_json.reason).toBe(REASON)
    expect(row.before_json.pdf_key).toBe('2026-09/INV-TB1.pdf')
    expect(row.after_json.pdf_key).toBeNull()
  })

  it('reports a failed audit write instead of swallowing it', async () => {
    const db = fakeDb({ auditError: 'permission denied for table audit_log' })
    const res = await edit(db, [
      { description: SALARY_DESC, qty: 1, unitPrice: 250 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 }
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.warnings.join(' ')).toMatch(/audit log/)
  })

  it('surfaces a read or write error rather than claiming success', async () => {
    const readFail = await edit(fakeDb({ readError: 'connection reset' }), [
      { description: SALARY_DESC, qty: 1, unitPrice: 250 }
    ])
    expect(readFail.ok).toBe(false)
    if (!readFail.ok) expect(readFail.status).toBe(500)

    const writeFail = await edit(fakeDb({ updateError: 'invoice system fields are read-only' }), [
      { description: SALARY_DESC, qty: 1, unitPrice: 250 },
      { description: REIMB_DESC, qty: 1, unitPrice: 112.4 }
    ])
    expect(writeFail.ok).toBe(false)
    if (!writeFail.ok) expect(writeFail.message).toMatch(/was NOT saved/)
  })

  it('404s on an invoice that does not exist', async () => {
    const res = await edit(fakeDb({ invoice: null }), [{ description: SALARY_DESC, qty: 1, unitPrice: 250 }])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })
})
