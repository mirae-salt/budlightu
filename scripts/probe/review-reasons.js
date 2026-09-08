/**
 * Q: Of the receipts sitting in the review queue, which are there for a real reason?
 *
 * Every receipt in `review` was put there by a reason string, and the inputs that
 * produced it are recorded on the row: `ambiguous_flags.spendable_cap`, the policy in
 * force, and the fraud flags. So the decision can be replayed against today's rules
 * without re-reading an image or calling a model, and the two answers compared.
 *
 * Why this exists. On 2026-09-08 sixteen of seventeen receipts in the queue said "totals
 * do not add up", and the amount stored on nearly all of them was already correct. Two
 * separate rules were firing on bottle deposits: the model reports the Bud Light product
 * and leaves the deposit out, so its figure disagreed with ours by exactly the deposit;
 * and the Beer Store does not itemise the deposit at all, so its receipts total more than
 * their own subtotal plus tax. Neither was a defect in the receipt. A queue that is
 * mostly noise is a queue nobody reads carefully, which is the actual risk.
 *
 * Read only. Reports what would change; scripts/probe/fix-reclassify-flagged-receipts.js
 * is the one that writes.
 *
 * Usage: node scripts/probe/review-reasons.js
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

/** The fraud flags today's rules would no longer raise, given the recorded OCR figures. */
function survivingFlags(flags, ocr, depositShapedGap) {
  const sub = Number(ocr?.subtotal ?? 0)
  const tax = Number(ocr?.tax ?? 0)
  const grand = Number(ocr?.grand_total ?? 0)
  return (flags ?? []).filter(f => {
    if (f.startsWith('total_mismatch:') && sub > 0 && tax > 0 && grand > 0) {
      return !depositShapedGap(sub, tax, grand)
    }
    return true
  })
}

async function main() {
  const db = serviceClient()
  const { classifyReceipt, depositShapedGap } = loadTs('lib/classify-receipt.ts')

  const { data: rows, error } = await db.from('receipts')
    .select('id, period, status, decision_reason, reverted_count, bud_light_total_incl_tax, ocr_json, ambiguous_flags, bams(first_name, last_name)')
    .eq('status', 'review')
  if (error) { fail(`receipts unreadable: ${error.message}`); return verdict('review reasons') }

  if (!rows?.length) { pass('the review queue is empty'); return verdict('review reasons') }
  info(`${rows.length} receipt(s) in review`)

  let clears = 0
  let stays = 0
  let unreplayable = 0

  for (const r of rows) {
    const who = `${r.bams?.first_name} ${r.bams?.last_name}`
    const cap = Number(r.ambiguous_flags?.spendable_cap)
    const pol = r.ambiguous_flags?.policy

    // No recorded inputs means no honest replay. Say so rather than inventing a cap.
    if (!r.ocr_json?.lines || !Number.isFinite(cap) || !pol) {
      info(`${who}: cannot replay (no recorded cap or policy), leaving alone`)
      unreplayable++
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

    const amountMoves = Math.abs(Number(now.budLightTotalInclTax) - Number(r.bud_light_total_incl_tax ?? 0)) > 0.01

    if (wouldBe === 'auto_pass') {
      clears++
      info(`${who} $${Number(r.bud_light_total_incl_tax).toFixed(2)}: would clear on its own` +
        `${r.reverted_count > 0 ? '  (an admin reopened this one, so it stays)' : ''}` +
        `${amountMoves ? `  AMOUNT MOVES to $${now.budLightTotalInclTax.toFixed(2)}` : ''}`)
    } else {
      stays++
      const why = [now.reason.split(':')[0], ...flags.map(f => f.split(':')[0])].join(', ')
      info(`${who} $${Number(r.bud_light_total_incl_tax).toFixed(2)}: stays in review (${why})`)
    }
  }

  info('')
  if (clears) info(`${clears} of ${rows.length} are in the queue for a reason today's rules no longer raise`)
  pass(`${stays} would still need a person, ${unreplayable} could not be replayed`)
  verdict('review reasons')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('review reasons') })
