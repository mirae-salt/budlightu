/**
 * Receipts a person approved ONLY because they sat just under the $150 cap are counted as
 * automatic now.
 *
 * WHY
 * ---
 * Until 2026-10-01 a receipt of $140 to $149.99 went to an admin with "Close to the monthly
 * cap". The review was a leftover of the retired PASS/REVIEW/FAIL model: the payout is the
 * receipt's own amount, so there was nothing to decide, and every one of them was approved
 * with the amount unchanged. The rule is off (lib/policy.ts, reviewBandPaddingCad = 0), so
 * today's code would have passed them. The dashboard counts by `status`, so these were
 * still shown as "Manually approved". This moves them to 'auto_pass'.
 *
 * WHAT IT KEEPS
 * -------------
 * The record of what actually happened. The row's decision_reason says a person approved it
 * and when, and audit_log holds the whole original decision (status, decided_by, decided_at,
 * reason). Nothing is deleted, and putting it back is one update from that audit row.
 *
 * WHO QUALIFIES (all of these, or it is left alone)
 *   - status 'approved' and a person decided it
 *   - the reason is the plain default, so nobody wrote anything
 *   - no Bud Light line was corrected and the amount was not overridden
 *   - replaying the classifier with the old band (10) gives review_band, and with the new
 *     one (0) gives auto_pass with the SAME amount, so the band was the only reason
 *
 * Dry run by default.
 * Usage: node scripts/probe/fix-reclassify-near-cap-as-auto.js [--apply]
 */
const { serviceClient, loadTs, pass, fail, info, verdict } = require('./_lib')

const APPLY = process.argv.includes('--apply')
const PLAIN = 'Meets Bud Light reimbursement criteria'

async function main() {
  const db = serviceClient()
  const { classifyReceipt } = loadTs('lib/classify-receipt.ts')
  info(APPLY ? 'APPLYING' : 'dry run, nothing will be written')

  const { data, error } = await db.from('receipts')
    .select('id, period, status, decided_by, decided_at, decision_reason, bud_light_total_incl_tax, ambiguous_flags, ocr_json, late_submission, reverted_count')
    .eq('status', 'approved')
    .not('decided_by', 'is', null)
  if (error) { fail(`receipts unreadable: ${error.message}`); return verdict('reclassify near-cap') }

  const who = new Map()
  const candidates = []
  for (const r of data ?? []) {
    if ((r.decision_reason ?? '').trim() !== PLAIN) continue          // someone wrote or corrected something
    if (r.ocr_json?.model_classification || r.ocr_json?.admin_classification) continue
    const f = r.ambiguous_flags ?? {}
    const p = f.policy ?? {}
    const fraud = Array.isArray(f.fraud_flags) ? f.fraud_flags : []
    if (fraud.length > 0) continue                                      // something else flagged it
    const run = padding => classifyReceipt({
      ocr: r.ocr_json ?? {},
      spendableCap: Number(f.spendable_cap ?? p.reimbursement_max ?? 150),
      policy: {
        reimbursementMax: p.reimbursement_max ?? 150,
        firstCohortAllReview: p.first_cohort_all_review === true,
        reviewBandPaddingCad: padding
      },
      duplicateHash: false,
      lowResolutionHeuristic: false,
      lateSubmission: r.late_submission === true
    })
    const before = run(10)
    const after = run(0)
    const stored = Number(r.bud_light_total_incl_tax)
    if (!/^review_band:/.test(before.reason)) continue
    if (after.status !== 'auto_pass') continue
    if (Math.abs(after.budLightTotalInclTax - stored) > 0.005) continue // the amount differs: not a pure rubber stamp
    candidates.push(r)
  }

  if (candidates.length === 0) { pass('nothing to reclassify'); return verdict('reclassify near-cap') }

  for (const r of candidates) {
    if (!who.has(r.decided_by)) {
      const { data: u } = await db.auth.admin.getUserById(r.decided_by)
      who.set(r.decided_by, u?.user?.email ?? r.decided_by)
    }
    const when = (r.decided_at ?? '').slice(0, 10)
    info(`${r.id.slice(0, 8)}  ${r.period.slice(0, 7)}  $${r.bud_light_total_incl_tax}  approved ${when} by ${who.get(r.decided_by)}`)
  }
  if (!APPLY) {
    info(`${candidates.length} receipt(s) qualify. Re-run with --apply.`)
    return verdict('reclassify near-cap')
  }

  for (const r of candidates) {
    const when = (r.decided_at ?? '').slice(0, 10)
    const note =
      `Auto-approved. Just under the $150 cap, which used to go to an admin. ` +
      `A person approved it on ${when} before that review was retired, with no change.`
    const { data: upd, error: uErr } = await db.from('receipts')
      .update({ status: 'auto_pass', decided_by: null, decided_at: null, decision_reason: note })
      .eq('id', r.id)
      .eq('status', 'approved')
      .select('id, status, decided_by, bud_light_total_incl_tax')
    if (uErr || !upd || upd.length !== 1) { fail(`${r.id.slice(0, 8)} NOT updated: ${uErr?.message ?? 'matched no row'}`); continue }
    if (upd[0].status !== 'auto_pass' || upd[0].decided_by !== null || Number(upd[0].bud_light_total_incl_tax) !== Number(r.bud_light_total_incl_tax)) {
      fail(`${r.id.slice(0, 8)} read back wrong: ${JSON.stringify(upd[0])}`)
      continue
    }
    const { error: aErr } = await db.from('audit_log').insert({
      actor_id: null,
      actor_role: 'system',
      entity: 'receipts',
      entity_id: r.id,
      action: 'reclassified_as_auto',
      before_json: {
        status: r.status, decided_by: r.decided_by, decided_by_email: who.get(r.decided_by),
        decided_at: r.decided_at, decision_reason: r.decision_reason, bud_light_total_incl_tax: r.bud_light_total_incl_tax
      },
      after_json: { status: 'auto_pass', decision_reason: note, why: 'near-cap review retired 2026-10-01' }
    })
    if (aErr) fail(`${r.id.slice(0, 8)} updated, but the audit row failed: ${aErr.message}`)
    else pass(`${r.id.slice(0, 8)} now auto_pass, amount unchanged, original decision kept in audit_log`)
  }
  verdict('reclassify near-cap')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('reclassify near-cap') })
