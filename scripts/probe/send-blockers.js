/**
 * Why is this invoice not going to AP?
 *
 * Replays every gate in app/api/admin/invoices/batch-approve against each draft invoice
 * and prints the FIRST one that refuses it, per invoice, grouped by reason.
 *
 * Written 2026-09-21, after "Batch approve failed (39 of 39 failed)" was retried for three
 * days. The reasons existed in the response the whole time and the screen printed only a
 * count, so the answer had to be dug out of production by hand. This is that dig, kept.
 *
 * Read-only. Calls the real rules from lib/, not copies of them, so a change to the rule
 * changes this probe too.
 *
 * Usage:  node scripts/probe/send-blockers.js [period]     default period 2026-09-01
 */
const { serviceClient, loadTs, pass, fail, info, verdict } = require('./_lib.js')

const period = process.argv[2] || '2026-09-01'

;(async () => {
  const db = serviceClient()
  const L = loadTs('lib/invoice-ledger.ts')

  const { data: invoices, error } = await db.from('invoices')
    .select('id, invoice_number, status, released_at, bam_id, cohort_id, period, payload_json, bams(status), cohorts(name, send_mode, po_number)')
  if (error) {
    fail('invoices read failed: ' + error.message)
    return verdict('send blockers')
  }

  const drafts = (invoices ?? []).filter(i => i.period === period && i.status === 'draft')
  info(`period ${period}: ${drafts.length} draft invoice(s)`)
  if (drafts.length === 0) return verdict('send blockers')

  const { data: threads } = await db.from('portal_questions').select('invoice_id, answered_at')
  const disputed = new Set((threads ?? []).filter(t => !t.answered_at).map(t => t.invoice_id))

  const groups = new Map()
  const add = (reason, num) => {
    const list = groups.get(reason) ?? []
    list.push(num)
    groups.set(reason, list)
  }

  for (const inv of drafts) {
    const c = inv.cohorts
    if (!c) { add('cohort not found', inv.invoice_number); continue }
    if (!c.po_number) { add(`cohort ${c.name} has no po_number (HARD BLOCK, fails the whole batch)`, inv.invoice_number); continue }
    if (inv.bams?.status !== 'active') { add(`BAM is ${inv.bams?.status ?? 'missing'}, not active`, inv.invoice_number); continue }
    if (disputed.has(inv.id)) { add('an unanswered question is open on it', inv.invoice_number); continue }
    if (!inv.released_at) { add('not released to the BAM yet', inv.invoice_number); continue }

    const bk = await db.rpc('decrypt_bam_banking', { p_bam_id: inv.bam_id })
    if (bk.error) { add(`banking could not be decrypted: ${bk.error.message}`, inv.invoice_number); continue }
    const cur = Array.isArray(bk.data) ? bk.data[0] : bk.data
    const dd = inv.payload_json?.directDeposit ?? {}
    const same = (a, b) => String(a ?? '') === String(b ?? '')
    if (!same(dd.institutionNumber, cur?.institution_no) ||
        !same(dd.transitNumber, cur?.transit_no) ||
        !same(dd.accountNumber, cur?.account_no)) {
      add('banking on the invoice disagrees with the roster', inv.invoice_number)
      continue
    }

    const ledger = await L.lookupReimbursement(db, inv.bam_id, inv.cohort_id, inv.period)
    if (!ledger.ok) { add(ledger.error, inv.invoice_number); continue }
    const mismatch = L.payloadLedgerMismatch(inv.payload_json?.lines, ledger.paidCad)
    if (mismatch) { add(mismatch, inv.invoice_number); continue }
    const undecided = await L.undecidedReceiptsProblem(db, inv.bam_id, inv.period)
    if (undecided) { add(undecided, inv.invoice_number); continue }

    add('NOTHING BLOCKS IT. The 24h window is the only thing left, and the screen shows that.', inv.invoice_number)
  }

  for (const [reason, nums] of groups) {
    const line = `${nums.length}: ${reason}  [${nums.slice(0, 6).join(', ')}${nums.length > 6 ? `, +${nums.length - 6}` : ''}]`
    if (reason.startsWith('NOTHING BLOCKS IT')) pass(line)
    else fail(line)
  }
  verdict('send blockers')
})()
