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
  const live = drafts.filter(i => i.cohorts?.send_mode === 'live')
  info(`period ${period}: ${drafts.length} draft invoice(s): ${live.length} in a live cohort, ${drafts.length - live.length} in a rehearsal cohort`)
  info(`decrypting banking one invoice at a time, so this takes about ${Math.ceil(drafts.length / 4)} seconds`)
  if (drafts.length === 0) return verdict('send blockers')

  const { data: threads } = await db.from('portal_questions').select('invoice_id, answered_at')
  const disputed = new Set((threads ?? []).filter(t => !t.answered_at).map(t => t.invoice_id))

  const groups = new Map()
  const add = (inv, reason) => {
    const key = `${inv.cohorts?.name ?? '?'}|${inv.cohorts?.send_mode ?? '?'}|${reason}`
    const list = groups.get(key) ?? []
    list.push(inv.invoice_number)
    groups.set(key, list)
  }

  for (const inv of drafts) {
    const c = inv.cohorts
    if (!c) { add(inv, 'cohort not found'); continue }
    if (!c.po_number) { add(inv, `cohort ${c.name} has no po_number (HARD BLOCK, fails the whole batch)`); continue }
    if (inv.bams?.status !== 'active') { add(inv, `BAM is ${inv.bams?.status ?? 'missing'}, not active`); continue }
    if (disputed.has(inv.id)) { add(inv, 'an unanswered question is open on it'); continue }
    if (!inv.released_at) { add(inv, 'not released to the BAM yet'); continue }

    const bk = await db.rpc('decrypt_bam_banking', { p_bam_id: inv.bam_id })
    if (bk.error) { add(inv, `banking could not be decrypted: ${bk.error.message}`); continue }
    const cur = Array.isArray(bk.data) ? bk.data[0] : bk.data
    const dd = inv.payload_json?.directDeposit ?? {}
    const same = (a, b) => String(a ?? '') === String(b ?? '')
    if (!same(dd.institutionNumber, cur?.institution_no) ||
        !same(dd.transitNumber, cur?.transit_no) ||
        !same(dd.accountNumber, cur?.account_no)) {
      add(inv, 'banking on the invoice disagrees with the roster')
      continue
    }

    const ledger = await L.lookupReimbursement(db, inv.bam_id, inv.cohort_id, inv.period)
    if (!ledger.ok) { add(inv, ledger.error); continue }
    const mismatch = L.payloadLedgerMismatch(inv.payload_json?.lines, ledger.paidCad)
    if (mismatch) { add(inv, mismatch); continue }
    const undecided = await L.undecidedReceiptsProblem(db, inv.bam_id, inv.period)
    if (undecided) { add(inv, undecided); continue }

    add(inv, 'NOTHING BLOCKS IT. The 24h window is the only thing left, and the screen shows that.')
  }

  for (const [key, nums] of groups) {
    const [cohort, mode, reason] = key.split('|')
    const line = `${cohort} (${mode})  ${nums.length}: ${reason}  [${nums.slice(0, 6).join(', ')}${nums.length > 6 ? `, +${nums.length - 6}` : ''}]`
    if (reason.startsWith('NOTHING BLOCKS IT')) pass(line)
    // A rehearsal cohort holding drafts is how a rehearsal cohort is supposed to look. Only a
    // live cohort blocking a real payment is worth a non-zero exit code.
    else if (mode === 'live') fail(line)
    else info(line)
  }
  verdict('send blockers')
})()
