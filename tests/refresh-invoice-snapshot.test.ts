import { describe, it, expect } from 'vitest'
import { mergeInvoiceSnapshot, refreshOpenInvoices, rosterDrift } from '../lib/refresh-invoice-snapshot'

const payload = {
  invoiceNumber: 'INV-ET1',
  influencer: {
    name: 'Emma Thompson',
    street: '56 Vin Vista Dr',
    cityProvPostal: 'Kingston, ON, K7K 4L9',
    email: 'emma@example.com',
    phone: '6136626070'
  },
  directDeposit: {
    bank: 'TD Canada Trust',
    institutionNumber: '004',
    transitNumber: '00042',
    accountNumber: '51334481',
    email: 'emma@example.com'
  },
  makeChecksTo: 'Emma Thompson',
  subtotal: 368.75,
  tax: 0,
  total: 368.75
}

describe('merging a roster correction into a stored invoice', () => {
  it('rebuilds the city line from all three parts when one of them changes', () => {
    const r = mergeInvoiceSnapshot(payload, { city: 'Ingleside', postal: 'K0C 1M0' })
    expect((r.next as typeof payload).influencer.cityProvPostal).toBe('Ingleside, ON, K0C 1M0')
    expect(r.changed).toContain('mailing address')
  })

  it('returns nothing to write when the values already match', () => {
    // Without this, editing a phone number would rewrite every open invoice and throw
    // away an archived PDF that was perfectly correct.
    const r = mergeInvoiceSnapshot(payload, { street: '56 Vin Vista Dr', city: 'Kingston', prov: 'ON', postal: 'K7K 4L9' })
    expect(r.next).toBeNull()
    expect(r.changed).toEqual([])
  })

  it('never touches the money', () => {
    const r = mergeInvoiceSnapshot(payload, { city: 'Ingleside', postal: 'K0C 1M0' })
    const next = r.next as typeof payload
    expect(next.subtotal).toBe(368.75)
    expect(next.total).toBe(368.75)
    expect(next.tax).toBe(0)
  })

  it('says so instead of recalculating when the province moves', () => {
    const r = mergeInvoiceSnapshot(payload, { city: 'Halifax', prov: 'NS', postal: 'B3H 1A1' })
    expect(r.warning).toMatch(/NOT recalculated/)
    expect((r.next as typeof payload).tax).toBe(0)
  })

  it('swaps the account number and keeps it a string', () => {
    // Lauren Burnett, 2026-09-17: one digit too many. The leading zeros on the
    // institution and transit are the reason none of this goes near a number type.
    const r = mergeInvoiceSnapshot(payload, { accountNo: '5134481', institutionNo: '003', transitNo: '00002' })
    const dd = (r.next as typeof payload).directDeposit
    expect(dd.accountNumber).toBe('5134481')
    expect(dd.institutionNumber).toBe('003')
    expect(dd.transitNumber).toBe('00002')
    expect(r.changed).toContain('account number')
  })

  it('moves the cheque payee with the name, because both render from the same two columns', () => {
    const r = mergeInvoiceSnapshot(payload, { lastName: 'Thompson-Reid' })
    const next = r.next as typeof payload
    expect(next.influencer.name).toBe('Emma Thompson-Reid')
    expect(next.makeChecksTo).toBe('Emma Thompson-Reid')
  })

  it('survives an invoice with no payload at all', () => {
    expect(mergeInvoiceSnapshot(null, { city: 'Ingleside' }).next).toBeNull()
  })
})

/**
 * Test double in the ARRAY form. `.maybeSingle()` is not implemented here on purpose:
 * a helper that reaches for it passes review and then fails against this double, which
 * is how the house shape stays the house shape.
 */
function fakeDb(rows: Array<{ id: string; period: string; status: string; payload_json: unknown }>, opts: {
  updateError?: string
  /** Simulate the write landing but pdf_key surviving. */
  keepPdfKey?: boolean
} = {}) {
  const updates: Array<Record<string, unknown>> = []
  const statusFilter: string[] = []
  return {
    updates,
    statusFilter,
    from() {
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = () => q
      q.in = (_col: string, vals: string[]) => { statusFilter.push(...vals); return q }
      q.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null })
      q.update = (patch: Record<string, unknown>) => {
        updates.push(patch)
        const u: Record<string, unknown> = {}
        u.eq = () => u
        u.select = () => Promise.resolve(
          opts.updateError
            ? { data: null, error: { message: opts.updateError } }
            : { data: [{ id: 'x', pdf_key: opts.keepPdfKey ? 'stale.pdf' : null }], error: null }
        )
        return u
      }
      return q
    }
  }
}

describe('pushing the correction out to open invoices', () => {
  const open = [{ id: 'i1', period: '2026-09-01', status: 'draft', payload_json: payload }]

  it('clears pdf_key, which is the half that reaches accounts payable', async () => {
    // The payload alone was already being swapped before this existed. The portal and
    // the admin preview re-render from it, so they looked right, while ensureInvoicePdf
    // handed AP the bytes stored under pdf_key from before the correction.
    const db = fakeDb(open)
    const r = await refreshOpenInvoices(db, 'bam-1', { accountNo: '5134481' })
    expect(r.ok).toBe(true)
    expect(db.updates[0].pdf_key).toBeNull()
    expect(r.notes[0]).toMatch(/updated: account number/)
  })

  it('only looks at invoices that have not gone out', async () => {
    const db = fakeDb(open)
    await refreshOpenInvoices(db, 'bam-1', { accountNo: '5134481' })
    expect(db.statusFilter).toEqual(['draft', 'approved'])
  })

  it('writes nothing when the correction changes nothing', async () => {
    const db = fakeDb(open)
    const r = await refreshOpenInvoices(db, 'bam-1', { accountNo: '51334481' })
    expect(db.updates).toEqual([])
    expect(r.notes).toEqual([])
  })

  it('reports a failed write as not ok, naming what is still wrong', async () => {
    const db = fakeDb(open, { updateError: 'permission denied' })
    const r = await refreshOpenInvoices(db, 'bam-1', { accountNo: '5134481' })
    expect(r.ok).toBe(false)
    expect(r.notes[0]).toMatch(/still shows the OLD account number/)
    expect(r.notes[0]).toMatch(/Do not send it/)
  })

  it('refuses to call it done when the archived PDF survived the write', async () => {
    const db = fakeDb(open, { keepPdfKey: true })
    const r = await refreshOpenInvoices(db, 'bam-1', { accountNo: '5134481' })
    expect(r.ok).toBe(false)
    expect(r.notes[0]).toMatch(/AP would receive the old document/)
  })

  it('does not fail the caller when the invoices cannot even be read', async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'down' } }) }) }) }) }
    const r = await refreshOpenInvoices(db, 'bam-1', { accountNo: '5134481' })
    expect(r.ok).toBe(false)
    expect(r.notes[0]).toMatch(/confirm them by hand/)
  })
})

describe('spotting an invoice that drifted from the roster', () => {
  const roster = {
    first_name: 'Emma', last_name: 'Thompson',
    email: 'emma@example.com', phone: '6136626070',
    street: '56 Vin Vista Dr', city: 'Kingston', prov: 'ON', postal: 'K7K 4L9'
  }

  it('says nothing when the invoice already matches', () => {
    expect(rosterDrift(payload, roster)).toEqual([])
  })

  it('names the address once the roster moves under it', () => {
    // The case the push already covers. This is the second line of defence, for the
    // write paths that never call it: CSV import, onboarding ingest, a fix- script.
    expect(rosterDrift(payload, { ...roster, city: 'Ingleside', postal: 'K0C 1M0' }))
      .toEqual(['mailing address'])
  })

  it('names several fields at once', () => {
    const d = rosterDrift(payload, { ...roster, phone: '4160000000', street: '1 King St' })
    expect(d).toContain('phone')
    expect(d).toContain('street')
  })

  it('reports field names only, never the values', () => {
    // This list is rendered in a badge and written to audit_log. A home address in
    // either of those is a second copy of PII nobody asked for.
    const d = rosterDrift(payload, { ...roster, city: 'Ingleside', postal: 'K0C 1M0' })
    expect(d.join(' ')).not.toMatch(/Ingleside|K0C/)
  })

  it('does not report banking, which has its own gate before the send', () => {
    // batch-approve re-decrypts and refuses to send on a banking mismatch. Comparing it
    // here would cost one decrypt per row to render a list of 55.
    expect(rosterDrift(payload, roster)).not.toContain('account number')
  })
})

describe('whitespace is not a change', () => {
  // INV-KR1, a live September invoice: the roster city is "Thornhill " with a trailing
  // space, baked into the payload the same way. A strict comparison rebuilt the line as
  // "Thornhill, ON, L3T 3K8", called it drift, and painted a real invoice red for a
  // character nobody can see.
  const spaced = {
    ...payload,
    influencer: { ...payload.influencer, cityProvPostal: 'Thornhill , ON, L3T 3K8', street: '59 Kirk drive' }
  }
  const roster = {
    first_name: 'Emma', last_name: 'Thompson', email: 'emma@example.com', phone: '6136626070',
    street: '59 Kirk drive', city: 'Thornhill ', prov: 'ON', postal: 'L3T 3K8'
  }

  it('does not flag an invoice whose only difference is a stray space', () => {
    expect(rosterDrift(spaced, roster)).toEqual([])
    expect(mergeInvoiceSnapshot(spaced, { city: 'Thornhill ', prov: 'ON', postal: 'L3T 3K8' }).next).toBeNull()
  })

  it('still flags and cleans a real change in the same field', () => {
    const r = mergeInvoiceSnapshot(spaced, { city: 'Markham', prov: 'ON', postal: 'L3R 0B8' })
    expect((r.next as typeof payload).influencer.cityProvPostal).toBe('Markham, ON, L3R 0B8')
  })
})
