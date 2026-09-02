/**
 * Undoes a review that only ever happened because of a policy we have since turned off.
 *
 * The reason string is written once, when a receipt is classified, and never revisited.
 * `Class of 2027` had first_cohort_all_review on for the few hours between the cohort
 * being created and the setting being corrected on 2026-09-02 at 16:20:48 UTC, so
 * anything classified inside that window is sitting in Robin's queue explaining itself
 * with a rule nobody is running.
 *
 * Two different receipts come out of that window, and they are not the same problem.
 *
 *   Some also have real reasons.  Only the retired clause is removed from the text. The
 *                                 receipt stays in review, for the reasons that are true.
 *
 *   Some have no other reason.    The classifier was happy with these and the retired
 *                                 flag is the only thing that stopped them. They are
 *                                 auto-passed, exactly the way api/receipts/ocr does it.
 *
 * AUTO-PASSING IS NOT A STATUS CHANGE
 *
 * An auto-passed receipt has to have its money computed. Setting `status` alone recreates
 * the bug fixed earlier on 2026-09-02, where auto_pass rows existed with no ledger row
 * and no invoice, and the dashboard read $0. So this calls the same
 * recomputeLedgerForPeriod the OCR route calls, and it FAILS CLOSED: if the ledger cannot
 * be written the receipt is left in review, because a receipt marked paid with no money
 * behind it is the one state nobody should find later.
 *
 * Every change is written to audit_log as actor_role 'system' with actor_id null. Nobody
 * clicked these; a script did, on a rule that changed.
 *
 * Dry run:  node scripts/probe/fix-stale-review-reason.js
 * Apply:    node scripts/probe/fix-stale-review-reason.js --apply
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const CLAUSE = 'first_cohort_all_review'
const APPLY = process.argv.includes('--apply')

async function logSystem(db, receiptId, action, before, after) {
  const { error } = await db.from('audit_log').insert({
    actor_id: null,
    actor_role: 'system',
    entity: 'receipts',
    entity_id: receiptId,
    action,
    before_json: before,
    after_json: after
  })
  if (error) fail(`  audit_log insert failed: ${error.message}`)
  else info('  logged to audit_log as system')
}

async function main() {
  const db = serviceClient()

  const { data: cohorts, error: cErr } = await db.from('cohorts').select('id, name, first_cohort_all_review')
  if (cErr) { fail(`cohorts unreadable: ${cErr.message}`); return verdict('stale review reason') }
  const policyOff = new Set(cohorts.filter(c => c.first_cohort_all_review === false).map(c => c.id))

  const { data: receipts, error: rErr } = await db.from('receipts')
    .select('id, uploaded_at, status, period, bam_id, decision_reason, bams(first_name, last_name, cohort_id)')
  if (rErr) { fail(`receipts unreadable: ${rErr.message}`); return verdict('stale review reason') }

  const stale = receipts.filter(r =>
    String(r.decision_reason || '').includes(CLAUSE) && policyOff.has(r.bams?.cohort_id))

  if (!stale.length) {
    pass('no receipt is held by a policy its cohort no longer runs')
    return verdict('stale review reason')
  }

  const { recomputeLedgerForPeriod } = loadTs('lib/recompute-ledger.ts')

  for (const r of stale) {
    const who = `${r.bams.first_name} ${r.bams.last_name}`
    const parts = String(r.decision_reason).split(' | ')
    const kept = parts.filter(p => !p.startsWith(CLAUSE))
    const onlyReason = kept.length === 0

    info(`${who}, uploaded ${r.uploaded_at}, status ${r.status}`)
    info(`  removing: ${parts.find(p => p.startsWith(CLAUSE))}`)
    for (const k of kept) info(`  keeping:  ${k}`)
    info(onlyReason
      ? '  that was its ONLY reason, so it becomes auto_pass and its money is computed'
      : '  real reasons remain, so it stays in review')

    if (!APPLY) { info('  dry run, nothing written'); continue }

    // ---- text-only case ----
    if (!onlyReason) {
      const next = kept.join(' | ')
      const { error: uErr } = await db.from('receipts').update({ decision_reason: next }).eq('id', r.id)
      if (uErr) { fail(`  update failed: ${uErr.message}`); continue }

      const { data: after, error: bErr } = await db.from('receipts')
        .select('decision_reason, status').eq('id', r.id).single()
      if (bErr || !after) { fail(`  wrote, but could not read back: ${bErr?.message ?? 'no row'}`); continue }
      if (after.decision_reason !== next || after.status !== r.status) {
        fail(`  read back does not match: ${JSON.stringify(after)}`); continue
      }
      pass(`  read back clean, status still ${after.status}`)
      await logSystem(db, r.id, 'stale_review_reason_removed',
        { decision_reason: r.decision_reason },
        { decision_reason: next, status: after.status })
      continue
    }

    // ---- auto-pass case: money first, status second ----
    if (!r.bam_id || !r.bams?.cohort_id || !r.period) {
      fail('  cannot settle: the receipt is missing bam, cohort or period, so it stays in review')
      continue
    }

    const reason = 'auto_pass: the only reason for review was a cohort policy that is no longer on'
    const { error: uErr } = await db.from('receipts')
      .update({ status: 'auto_pass', decision_reason: reason }).eq('id', r.id)
    if (uErr) { fail(`  update failed: ${uErr.message}`); continue }

    const ledger = await recomputeLedgerForPeriod(db, {
      bamId: r.bam_id,
      cohortId: r.bams.cohort_id,
      period: r.period
    })

    if (!ledger.ok) {
      // FAIL CLOSED, the same way api/receipts/ocr does. Put it back in review rather
      // than leave a receipt marked auto_pass with no money computed behind it.
      const held = `${reason} | auto-pass held for review: the reimbursement could not be recorded (${ledger.error})`
      const { error: hErr } = await db.from('receipts')
        .update({ status: 'review', decision_reason: held.slice(0, 1000) }).eq('id', r.id)
      if (hErr) fail(`  LEDGER FAILED (${ledger.error}) AND THE HOLD FAILED (${hErr.message}): this row is auto_pass with no ledger, check it by hand`)
      else fail(`  ledger failed (${ledger.error}), so it was put back in review`)
      continue
    }

    const { data: after, error: bErr } = await db.from('receipts')
      .select('status, decision_reason').eq('id', r.id).single()
    if (bErr || after?.status !== 'auto_pass') {
      fail(`  wrote, but read back says ${bErr?.message ?? after?.status}`); continue
    }
    pass(`  auto_pass, paid $${ledger.paidCad.toFixed(2)} of $${ledger.spentCad.toFixed(2)} spent`)
    await logSystem(db, r.id, 'auto_passed_after_policy_change',
      { status: r.status, decision_reason: r.decision_reason },
      { status: 'auto_pass', decision_reason: reason, paid_cad: ledger.paidCad })

    info('  run scripts/probe/autopass-ledger-gap.js to confirm the invoice followed')
  }

  verdict('stale review reason')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('stale review reason') })
