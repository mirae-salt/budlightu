/**
 * Rewrites the reason on receipts that stay in review, so Robin reads why they are there
 * today rather than why they were put there.
 *
 * A receipt's `decision_reason` is written once, when it is classified, and nothing ever
 * revisits it. So when a rule is corrected, a receipt that CLEARS gets a new reason from
 * fix-reclassify-flagged-receipts, and a receipt that STAYS keeps the old wrong text
 * forever. On 2026-09-08 four of the six receipts left in the queue said "totals do not
 * add up" about a bottle deposit that had already been accounted for. Every one of them
 * genuinely belonged in the queue, for the cap. The explanation was the part that lied.
 *
 * That is worse than it sounds. The whole point of touchpoint 1 is that a person reads
 * the reason and decides. A reason that is reliably wrong teaches them to skip it.
 *
 * THIS ONE MOVES NO MONEY. It never changes `status` and never changes
 * `bud_light_total_incl_tax`. It rewrites one text column, and it refuses to run on any
 * receipt whose status would change, because deciding that is
 * fix-reclassify-flagged-receipts' job and doing it in two places is how the two answers
 * drift apart.
 *
 * Dry run:  node scripts/probe/fix-refresh-review-reasons.js
 * Apply:    node scripts/probe/fix-refresh-review-reasons.js --apply
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const APPLY = process.argv.includes('--apply')

/** The fraud flags today's rules would still raise, given the recorded OCR figures. */
function survivingFlags(flags, ocr, depositShapedGap) {
  const sub = Number(ocr?.subtotal ?? 0)
  const tax = Number(ocr?.tax ?? 0)
  const grand = Number(ocr?.grand_total ?? 0)
  const kept = []
  for (const f of flags ?? []) {
    if (f.startsWith('total_mismatch:') && sub > 0 && tax > 0 && grand > 0 && depositShapedGap(sub, tax, grand)) continue
    // The same product on two lines was two identical warnings.
    if (kept.includes(f)) continue
    kept.push(f)
  }
  return kept
}

async function main() {
  const db = serviceClient()
  const { classifyReceipt, depositShapedGap } = loadTs('lib/classify-receipt.ts')

  const { data: rows, error } = await db.from('receipts')
    .select('id, status, decision_reason, bud_light_total_incl_tax, ocr_json, ambiguous_flags, bams(first_name, last_name)')
    .eq('status', 'review')
  if (error) { fail(`receipts unreadable: ${error.message}`); return verdict('refresh review reasons') }
  if (!rows?.length) { pass('the review queue is empty'); return verdict('refresh review reasons') }

  let changed = 0
  let sameAlready = 0

  for (const r of rows) {
    const who = `${r.bams?.first_name} ${r.bams?.last_name}`
    const cap = Number(r.ambiguous_flags?.spendable_cap)
    const pol = r.ambiguous_flags?.policy
    if (!r.ocr_json?.lines || !Number.isFinite(cap) || !pol) {
      info(`${who}: no recorded cap or policy, cannot replay, leaving alone`)
      continue
    }

    const now = classifyReceipt({
      ocr: r.ocr_json,
      spendableCap: cap,
      policy: {
        reimbursementMax: pol.reimbursement_max,
        reviewBandPaddingCad: pol.review_band_padding_cad,
        firstCohortAllReview: pol.first_cohort_all_review
      },
      duplicateHash: false,
      lowResolutionHeuristic: false
    })
    const flags = survivingFlags(r.ambiguous_flags?.fraud_flags, r.ocr_json, depositShapedGap)
    const wouldBe = now.status === 'rejected' ? 'rejected' : (flags.length ? 'review' : now.status)

    // Anything that would move is not this script's business.
    if (wouldBe !== 'review') {
      info(`${who}: would now be ${wouldBe}, so leaving it to fix-reclassify-flagged-receipts`)
      continue
    }
    // The amount is the other script's business too, and it should never differ here.
    if (Math.abs(now.budLightTotalInclTax - Number(r.bud_light_total_incl_tax ?? 0)) > 0.01) {
      info(`${who}: the amount would move to $${now.budLightTotalInclTax.toFixed(2)}, leaving it to fix-recompute-deposit-receipts`)
      continue
    }

    const next = [now.reason, ...flags].join(' | ').slice(0, 1000)
    if (next === r.decision_reason) { sameAlready++; continue }

    changed++
    info(`${who} $${Number(r.bud_light_total_incl_tax).toFixed(2)}`)
    info(`   was: ${String(r.decision_reason).slice(0, 150)}`)
    info(`   now: ${next.slice(0, 150)}`)

    if (!APPLY) continue

    const { error: uErr } = await db.from('receipts')
      .update({ decision_reason: next })
      .eq('id', r.id).eq('status', 'review')   // if a person just decided it, do not touch
    if (uErr) { fail(`   update failed: ${uErr.message}`); continue }

    const { data: after, error: bErr } = await db.from('receipts')
      .select('status, decision_reason, bud_light_total_incl_tax').eq('id', r.id).single()
    if (bErr || !after) { fail(`   wrote, but could not read back: ${bErr?.message ?? 'no row'}`); continue }
    if (after.decision_reason !== next) { fail('   read back does not match what was written'); continue }
    if (after.status !== 'review') { fail(`   status is now ${after.status}, which this script must never cause`); continue }
    if (Math.abs(Number(after.bud_light_total_incl_tax) - Number(r.bud_light_total_incl_tax)) > 0.001) {
      fail('   the amount moved, which this script must never cause'); continue
    }
    pass('   rewritten, status and amount untouched')

    const { error: aErr } = await db.from('audit_log').insert({
      actor_id: null,
      actor_role: 'system',
      entity: 'receipts',
      entity_id: r.id,
      action: 'review_reason_refreshed',
      before_json: { decision_reason: r.decision_reason },
      after_json: { decision_reason: next }
    })
    if (aErr) fail(`   audit_log insert failed: ${aErr.message}`)
  }

  info('')
  if (sameAlready) info(`${sameAlready} already said the right thing`)
  if (!changed) { pass('every reason in the queue is current'); return verdict('refresh review reasons') }
  if (!APPLY) info(`${changed} reason(s) are out of date. Re-run with --apply to rewrite.`)
  verdict('refresh review reasons')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('refresh review reasons') })
