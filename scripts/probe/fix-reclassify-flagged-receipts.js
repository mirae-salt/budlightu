/**
 * Re-decides receipts that are only in the review queue because of a rule we have since
 * corrected.
 *
 * On 2026-09-08 sixteen of seventeen receipts waiting for Robin said "totals do not add
 * up". Eleven of them were there for the bottle deposit and nothing else: the model
 * reports the Bud Light product and leaves the deposit out, so its figure disagreed with
 * ours by exactly the deposit; and the Beer Store does not itemise the deposit at all, so
 * its receipts total more than their own subtotal plus tax. Both rules were fixed in
 * lib/classify-receipt.ts. Fixing them changes nothing that already exists, because a
 * receipt's status was written once and is never revisited. This is the deliberate pass.
 *
 * THIS ONE MOVES MONEY. A receipt in `review` is not counted as spend
 * (SPENT_RECEIPT_STATES), so moving it to `auto_pass` raises the BAM's reimbursement.
 * That is the point, and it is why every safeguard below exists.
 *
 * WHAT IT WILL NOT DO
 *
 *   It never rejects. If today's rules would reject a receipt that is currently in
 *   review, it is left in review and reported. Auto-rejecting somebody who is already
 *   waiting on a person is the one direction that cannot be undone by a person clicking
 *   approve.
 *
 *   It never touches a receipt an admin reopened (reverted_count > 0). Robin put those
 *   back in the queue on purpose.
 *
 *   It refuses the whole run if any affected invoice has left draft, rather than doing
 *   the safe half and leaving somebody to work out which.
 *
 *   It re-decides from the STORED ocr_json and the cap and policy RECORDED on the row at
 *   the time. No image is re-read and no model is called, so the only thing that changes
 *   is a rule that is now right.
 *
 * Dry run:  node scripts/probe/fix-reclassify-flagged-receipts.js
 * Apply:    node scripts/probe/fix-reclassify-flagged-receipts.js --apply
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const APPLY = process.argv.includes('--apply')

/**
 * Include receipts an admin reopened by hand.
 *
 * Off by default, because a reopen is a person deciding to look and the system should not
 * overrule that. It exists because of Eloise Bergeron: Janet reopened both of hers on
 * 2026-09-04 giving the reason "System did not read receipt correctly", and that reading
 * was the deposit bug. The amounts now match the printed totals on her two photos, so the
 * condition Janet reopened them for is gone. Deciding that is still a person's call, which
 * is why it is a flag and not a rule.
 */
const INCLUDE_REOPENED = process.argv.includes('--include-reopened')

const NOTE = 'recleared 2026-09-08: the bottle deposit is not a totals mismatch'

/** The fraud flags today's rules would no longer raise, given the recorded OCR figures. */
function survivingFlags(flags, ocr, depositShapedGap, ctx) {
  const sub = Number(ocr?.subtotal ?? 0)
  const tax = Number(ocr?.tax ?? 0)
  const grand = Number(ocr?.grand_total ?? 0)
  return (flags ?? []).filter(f => {
    if (f.startsWith('total_mismatch:') && sub > 0 && tax > 0 && grand > 0) {
      return !depositShapedGap(sub, tax, grand)
    }
    // Same rule as the cap: the remaining balance is what gets paid either way, so this
    // only holds a receipt whose amount nothing corroborates. See the route for the note.
    if (f.startsWith('over_balance:')) {
      const coveredByTheCapMessage = ctx.capCad > 0 && ctx.total >= ctx.capCad
      return !(ctx.corroborated || coveredByTheCapMessage)
    }
    // Removed on 2026-09-08 because it needed to know what a Bud Light costs. A receipt
    // held only by a rule that no longer exists should not still be held.
    if (f.startsWith('price_outlier:')) return false
    return true
  })
}

async function main() {
  const db = serviceClient()
  const { classifyReceipt, depositShapedGap, recomputeBudLightTotal } = loadTs('lib/classify-receipt.ts')
  const { recomputeLedgerForPeriod } = loadTs('lib/recompute-ledger.ts')
  const { upsertDraftInvoice } = loadTs('lib/draft-invoice.ts')

  const { data: rows, error } = await db.from('receipts')
    .select('id, bam_id, cohort_id, period, status, decision_reason, reverted_count, bud_light_total_incl_tax, ocr_json, ambiguous_flags, bams(first_name, last_name)')
    .eq('status', 'review')
  if (error) { fail(`receipts unreadable: ${error.message}`); return verdict('reclassify flagged receipts') }
  if (!rows?.length) { pass('the review queue is empty'); return verdict('reclassify flagged receipts') }

  const clearing = []
  for (const r of rows) {
    const who = `${r.bams?.first_name} ${r.bams?.last_name}`
    const cap = Number(r.ambiguous_flags?.spendable_cap)
    const pol = r.ambiguous_flags?.policy
    if (!r.ocr_json?.lines || !Number.isFinite(cap) || !pol) continue

    if (r.reverted_count > 0 && !INCLUDE_REOPENED) {
      info(`${who}: an admin reopened this one, leaving it alone (--include-reopened to override)`)
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
    if (now.status === 'rejected') {
      info(`${who}: today's rules would REJECT this, so it stays in review for a person`)
      continue
    }
    const flags = survivingFlags(r.ambiguous_flags?.fraud_flags, r.ocr_json, depositShapedGap, {
      corroborated: recomputeBudLightTotal(r.ocr_json).matchesPrintedTotal,
      capCad: cap,
      total: now.budLightTotalInclTax
    })
    if (flags.length || now.status !== 'auto_pass') continue

    clearing.push({ r, now, who })
  }

  if (!clearing.length) { pass('nothing in the queue clears under the corrected rules'); return verdict('reclassify flagged receipts') }

  let locked = 0
  for (const c of clearing) {
    const { data: inv, error: iErr } = await db.from('invoices')
      .select('invoice_number, status').eq('bam_id', c.r.bam_id).eq('period', c.r.period)
    if (iErr) { fail(`invoice lookup failed: ${iErr.message}`); return verdict('reclassify flagged receipts') }
    const sent = (inv ?? []).filter(i => i.status !== 'draft')
    if (sent.length) {
      fail(`${c.who} ${c.r.period}: ${sent.map(i => `${i.invoice_number} is ${i.status}`).join(', ')}`)
      locked++
    }
  }
  if (locked) {
    fail(`${locked} receipt(s) sit behind an invoice that has left draft. Nothing was written.`)
    return verdict('reclassify flagged receipts')
  }
  pass(`all ${clearing.length} affected invoices are still draft`)

  /*
   * Each receipt was judged against the cap that was left when IT arrived, and clearing
   * several at once can put a BAM over that cap between them. No money escapes, because
   * the ledger caps what is paid, but the over-balance check that would fire on a fresh
   * submission does not fire on a replay. Say so, rather than let it pass silently.
   */
  const byPeriod = new Map()
  for (const c of clearing) {
    const key = `${c.r.bam_id}|${c.r.period}`
    if (!byPeriod.has(key)) byPeriod.set(key, { who: c.who, period: c.r.period, sum: 0 })
    byPeriod.get(key).sum += Number(c.now.budLightTotalInclTax)
  }
  for (const [key, v] of byPeriod) {
    const bamId = key.split('|')[0]
    const { data: led } = await db.from('reimbursement_ledger')
      .select('spent_cad, spendable_cap_cad').eq('bam_id', bamId).eq('period', v.period)
    const already = Number(led?.[0]?.spent_cad ?? 0)
    const cap = Number(led?.[0]?.spendable_cap_cad ?? 0)
    if (cap > 0 && already + v.sum > cap + 0.01) {
      info(`NOTE  ${v.who} ${v.period}: these clear to $${(already + v.sum).toFixed(2)} against a $${cap.toFixed(2)} cap, so she is paid the cap. Nobody was asked about going over.`)
    }
  }

  for (const { r, now, who } of clearing) {
    const before = Number(r.bud_light_total_incl_tax ?? 0)
    const moves = Math.abs(now.budLightTotalInclTax - before) > 0.01
    info(`${who} ${r.period}: review -> auto_pass at $${now.budLightTotalInclTax.toFixed(2)}` +
      `${moves ? ` (amount also moves from $${before.toFixed(2)})` : ''}` +
      `${r.reverted_count > 0 ? '  [OVERRIDES an admin reopen]' : ''}`)

    if (!APPLY) { info('  dry run, nothing written'); continue }

    const reason = `${now.reason} | ${NOTE}`.slice(0, 1000)
    const { error: uErr } = await db.from('receipts').update({
      status: 'auto_pass',
      bud_light_total_incl_tax: now.budLightTotalInclTax,
      decision_reason: reason
    }).eq('id', r.id).eq('status', 'review')   // lost update guard: a person may have just decided it
    if (uErr) { fail(`  update failed: ${uErr.message}`); continue }

    const { data: after, error: bErr } = await db.from('receipts')
      .select('status, bud_light_total_incl_tax').eq('id', r.id).single()
    if (bErr || !after) { fail(`  wrote, but could not read back: ${bErr?.message ?? 'no row'}`); continue }
    if (after.status !== 'auto_pass') { fail(`  read back says status ${after.status}, expected auto_pass`); continue }
    if (Math.abs(Number(after.bud_light_total_incl_tax) - now.budLightTotalInclTax) > 0.001) {
      fail(`  read back says $${after.bud_light_total_incl_tax}, expected $${now.budLightTotalInclTax.toFixed(2)}`); continue
    }
    pass(`  now auto_pass at $${Number(after.bud_light_total_incl_tax).toFixed(2)}`)

    const { error: aErr } = await db.from('audit_log').insert({
      actor_id: null,
      actor_role: 'system',
      entity: 'receipts',
      entity_id: r.id,
      action: 'recleared_deposit_flag_fix',
      before_json: { status: 'review', bud_light_total_incl_tax: before, decision_reason: r.decision_reason, fraud_flags: r.ambiguous_flags?.fraud_flags ?? [] },
      after_json: { status: 'auto_pass', bud_light_total_incl_tax: now.budLightTotalInclTax, basis: now.recomputeBasis, decision_reason: reason }
    })
    if (aErr) fail(`  audit_log insert failed: ${aErr.message}`)
  }

  if (!APPLY) { info('re-run with --apply to write'); return verdict('reclassify flagged receipts') }

  // auto_pass counts as spend, so the ledger and the draft invoice have to follow.
  const periods = [...new Set(clearing.map(c => `${c.r.bam_id}|${c.r.cohort_id}|${c.r.period}`))]
  info('')
  for (const key of periods) {
    const [bamId, cohortId, period] = key.split('|')
    const who = clearing.find(c => c.r.bam_id === bamId).who
    const led = await recomputeLedgerForPeriod(db, { bamId, cohortId, period })
    if (!led.ok) { fail(`${who} ${period}: ledger failed: ${led.error}`); continue }
    pass(`${who} ${period}: spent $${led.spentCad.toFixed(2)}, paid $${led.paidCad.toFixed(2)}`)
    const inv = await upsertDraftInvoice(db, bamId, cohortId, period, { quietWhenLedgerPending: true })
    info(inv.ok ? '   draft invoice rebuilt' : `   invoice not rebuilt: ${inv.reason}`)
  }

  verdict('reclassify flagged receipts')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('reclassify flagged receipts') })
