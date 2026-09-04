/**
 * Admin correction of which receipt lines are Bud Light (touchpoint 1, second half).
 *
 * The queue showed a tick per line and a total, and Robin could only APPROVE or
 * REJECT. A mis-tagged `CHIPS LAYS SEL` could not be untagged, and `override_total`
 * only let her retype the number while the wrong classification stayed on the
 * record. These tests cover the properties that decide how much a student is paid:
 *
 *   1. untick a line and the total goes DOWN; tick one and it goes UP
 *   2. the tax basis is whatever recomputeBudLightTotal picks, never our own maths
 *   3. a bad index list is refused before anything is written
 *   4. an empty selection does not silently pay $0
 *   5. both fields supplied behaves as AMOUNT_PRECEDENCE says, and says so
 *   6. the audit payload carries both totals and the lines that moved, in the exact
 *      column shape audit_log has (no `meta`, which PostgREST would drop silently)
 *
 * Plus the shape of the decide route, in the style of rls-shape.test.ts: the route
 * is what actually persists this, so its rollback discipline and its refusal to
 * trust a client total are asserted rather than assumed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  validateBudLightLines,
  applyBudLightCorrection,
  planReceiptCorrection,
  annotateCorrectedOcr,
  buildCorrectionAudit,
  currentBudLightIndices,
  currentBudLightFlags,
  ocrLineObjects,
  AMOUNT_PRECEDENCE
} from '../lib/receipt-correction'
import { recomputeBudLightTotal } from '../lib/classify-receipt'

const ROUTE = readFileSync(
  join(__dirname, '..', 'app', 'api', 'admin', 'receipts', 'decide', 'route.ts'),
  'utf8'
)
const PAGE = readFileSync(
  join(__dirname, '..', 'app', 'admin', 'receipts', 'page.tsx'),
  'utf8'
)
/*
 * The ledger arithmetic moved out of the route on 2026-08-26. It had been written out
 * four times (decide, revert, scheduler-audit, and the auto-pass path) and the copies
 * had begun to disagree, so it now lives in one file that all four call.
 *
 * These tests kept asserting on the route's text and failed the moment the code moved,
 * which is the correct behaviour for a test like this: it noticed. The fix is to point
 * them at where the guarantee now lives, NOT to relax them. Every property checked
 * below is still checked, just against the file that owns it.
 */
const LEDGER = readFileSync(
  join(__dirname, '..', 'lib', 'recompute-ledger.ts'),
  'utf8'
)

/**
 * The real receipt from production: Metro, Montreal, 8 lines, 3 ticked by the model
 * (BUDLIG.BIERE CAN 12X355 $22.95, BUDLIG.LIME 6X355 $14.95, BUDLISELT.EAU P.
 * 6X355 $12.95), stored total $58.45.
 *
 * $58.45 / $50.85 pre-tax implies 14.95%, which is Quebec's 14.975% within the
 * half-point tolerance, so recomputeBudLightTotal accepts the reported figure via
 * `lines_mixed_rate_validated`. The grocery lines are zero-rated, so the receipt's
 * own blended rate (10.31%) is NOT the beer rate and is deliberately not applied.
 */
const METRO = {
  store: 'Metro',
  date: '2026-08-02',
  currency: 'CAD',
  lines: [
    { desc: 'BUDLIG.BIERE CAN 12X355', qty: 1, unit: 22.95, total: 22.95, is_bud_light: true, confidence: 0.97 },
    { desc: 'CHIPS LAYS SEL', qty: 1, unit: 4.49, total: 4.49, is_bud_light: false, confidence: 0.98 },
    { desc: 'BUDLIG.LIME 6X355', qty: 1, unit: 14.95, total: 14.95, is_bud_light: true, confidence: 0.96 },
    { desc: 'LAIT 2% 2L', qty: 1, unit: 5.79, total: 5.79, is_bud_light: false, confidence: 0.99 },
    { desc: 'BUDLISELT.EAU P. 6X355', qty: 1, unit: 12.95, total: 12.95, is_bud_light: true, confidence: 0.91 },
    { desc: 'PAIN TRANCHE', qty: 1, unit: 3.99, total: 3.99, is_bud_light: false, confidence: 0.99 },
    { desc: 'BANANES', qty: 1, unit: 2.31, total: 2.31, is_bud_light: false, confidence: 0.99 },
    { desc: 'OEUFS 12', qty: 1, unit: 6.49, total: 6.49, is_bud_light: false, confidence: 0.99 }
  ],
  subtotal: 73.92,
  tax: 7.62,
  grand_total: 81.54,
  bud_light_total_incl_tax: 58.45,
  overall_confidence: 0.94
}

/** A receipt whose line totals reconcile to grand_total, so they already include tax. */
const TAX_INCLUSIVE = {
  store: 'The Beer Store',
  date: '2026-08-03',
  lines: [
    { desc: 'BUD LIGHT 12PK', qty: 1, unit: 28.25, total: 28.25, is_bud_light: true, confidence: 0.98 },
    { desc: 'BUD LIGHT LIME 6PK', qty: 1, unit: 16.5, total: 16.5, is_bud_light: false, confidence: 0.62 },
    { desc: 'ICE BAG', qty: 1, unit: 4.0, total: 4.0, is_bud_light: false, confidence: 0.99 }
  ],
  subtotal: 43.14,
  tax: 5.61,
  grand_total: 48.75,
  bud_light_total_incl_tax: 28.25,
  overall_confidence: 0.93
}

describe('the Metro receipt as the model read it', () => {
  it('reproduces the stored $58.45 and the basis it came from', () => {
    const rc = recomputeBudLightTotal(METRO as never)
    expect(rc.basis).toBe('lines_mixed_rate_validated')
    expect(rc.total).toBeCloseTo(58.45, 2)
    expect(rc.budLightPreTax).toBeCloseTo(50.85, 2)
    expect(currentBudLightIndices(METRO)).toEqual([0, 2, 4])
  })
})

describe('a toggled-off line lowers the total', () => {
  it('unticking BUDLISELT.EAU P. drops the seltzer out of the Bud Light sum', () => {
    const corr = applyBudLightCorrection(METRO, [0, 2])
    expect(corr.removed).toEqual([4])
    expect(corr.added).toEqual([])
    expect(corr.changed).toEqual([4])
    expect(corr.changedLines).toEqual([
      { index: 4, desc: 'BUDLISELT.EAU P. 6X355', total: 12.95, was: true, now: false }
    ])
    // 22.95 + 14.95. Lower than the $58.45 on record either way.
    expect(corr.recomputed.total).toBeCloseTo(37.9, 2)
    expect(corr.recomputed.total).toBeLessThan(corr.previousRecomputed.total)
    expect(corr.previousRecomputed.total).toBeCloseTo(58.45, 2)
  })

  it('the tax basis is whatever recomputeBudLightTotal chooses, not our arithmetic', () => {
    const corr = applyBudLightCorrection(METRO, [0, 2])
    // The model's $58.45 described a DIFFERENT set of lines, so it is stripped before
    // recomputing and the receipt falls to the conservative pre-tax basis. Never an
    // overpay; the reviewer supplies the tax-inclusive figure if the paper shows one.
    expect(corr.recomputed.basis).toBe('lines_mixed_pretax')
    expect(corr.recomputed.mixedPreTax).toBe(true)
    expect(corr.recomputed.total).toBe(corr.recomputed.budLightPreTax)
    // Identical to asking the tested function directly with the corrected flags and
    // no model claim: this file adds no tax maths of its own.
    const direct = recomputeBudLightTotal({
      ...METRO,
      bud_light_total_incl_tax: undefined,
      lines: METRO.lines.map((l, i) => ({ ...l, is_bud_light: i === 0 || i === 2 }))
    } as never)
    expect(corr.recomputed.total).toBe(direct.total)
    expect(corr.recomputed.basis).toBe(direct.basis)
  })

  it('a stale model claim can never validate a tax rate for a different line set', () => {
    // Guard on the strip: if the claim were kept, recompute could accept $58.45 as
    // corroborated for a set of lines that never added up to it.
    for (const sel of [[0], [2], [4], [0, 4], [2, 4], [0, 2], [0, 2, 4, 1]]) {
      const corr = applyBudLightCorrection(METRO, sel)
      if (corr.changed.length === 0) continue
      expect(corr.recomputed.basis).not.toBe('lines_mixed_rate_validated')
      expect(corr.recomputed.total).toBeLessThanOrEqual(
        corr.recomputed.budLightPreTax + 0.005
      )
    }
  })
})

describe('a toggled-on line raises the total', () => {
  it('ticking a missed Bud Light line adds its amount on a tax-inclusive receipt', () => {
    const corr = applyBudLightCorrection(TAX_INCLUSIVE, [0, 1])
    expect(corr.added).toEqual([1])
    expect(corr.removed).toEqual([])
    expect(corr.recomputed.basis).toBe('lines_incl_tax')
    expect(corr.previousRecomputed.total).toBeCloseTo(28.25, 2)
    expect(corr.recomputed.total).toBeCloseTo(44.75, 2)   // 28.25 + 16.50
    expect(corr.recomputed.total).toBeGreaterThan(corr.previousRecomputed.total)
  })

  it('ticking every line on the Metro receipt uses the receipt own tax rate', () => {
    const all = METRO.lines.map((_l, i) => i)
    const corr = applyBudLightCorrection(METRO, all)
    // No line is left out, so `tax / subtotal` IS the rate for the whole basket and
    // recomputeBudLightTotal grosses up. 73.92 * (1 + 7.62/73.92) = 81.54.
    // Basis renamed 2026-09-04: an all-Bud-Light receipt now takes the printed total
    // directly (lines_all_bud_light) instead of rebuilding it from the rate. Same
    // number, and it is the version that cannot miss an unitemised deposit.
    expect(corr.recomputed.basis).toBe('lines_all_bud_light')
    expect(corr.recomputed.total).toBeCloseTo(81.54, 2)
    expect(corr.recomputed.total).toBeGreaterThan(58.45)
    expect(corr.added).toEqual([1, 3, 5, 6, 7])
  })
})

describe('bad indices are refused before anything is written', () => {
  it('out of range', () => {
    const res = validateBudLightLines(METRO, [0, 8])
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.message).toMatch(/line 8/)
      expect(res.message).toMatch(/0 to 7/)
    }
    expect(validateBudLightLines(METRO, [-1]).ok).toBe(false)
  })

  it('duplicates', () => {
    const res = validateBudLightLines(METRO, [0, 2, 2])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/more than once/)
  })

  it('non-integers, including the string and boolean shapes JSON lets through', () => {
    for (const bad of [[1.5], ['2'], [true], [null], [NaN], [Infinity], [{ i: 1 }]]) {
      const res = validateBudLightLines(METRO, bad)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.message).toMatch(/whole line numbers/)
    }
  })

  it('not an array at all', () => {
    const res = validateBudLightLines(METRO, 3)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/must be an array/)
  })

  it('a receipt with no line items says so instead of accepting indices', () => {
    for (const ocr of [null, undefined, {}, { lines: [] }, { lines: 'nope' }]) {
      const res = validateBudLightLines(ocr, [0])
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.message).toMatch(/no readable line items/)
    }
  })

  it('a valid list is sorted and accepted', () => {
    const res = validateBudLightLines(METRO, [4, 0, 2])
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.indices).toEqual([0, 2, 4])
  })
})

describe('planReceiptCorrection', () => {
  const base = { ocrJson: METRO, overrideTotal: null, decision: 'approved' as const }

  it('no correction sent leaves the stored amount alone', () => {
    const plan = planReceiptCorrection({ ...base, budLightLines: undefined })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.correction).toBeNull()
    expect(plan.changed).toBe(false)
    expect(plan.amountSource).toBe('unchanged')
    expect(plan.amount).toBeNull()
  })

  it('a selection identical to the record is a no-op, NOT a silent re-derivation', () => {
    // Sending the unchanged selection must not knock $58.45 down to the $50.85
    // pre-tax sum: nothing was corrected, so the model's corroborated figure stands.
    const plan = planReceiptCorrection({ ...base, budLightLines: [0, 2, 4] })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.changed).toBe(false)
    expect(plan.correction).toBeNull()
    expect(plan.amount).toBeNull()
  })

  it('a real change carries the recomputed amount', () => {
    const plan = planReceiptCorrection({ ...base, budLightLines: [0, 2] })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.changed).toBe(true)
    expect(plan.amountSource).toBe('corrected_lines')
    expect(plan.amount).toBeCloseTo(37.9, 2)
    expect(plan.correction?.recomputed.total).toBe(plan.amount)
  })

  it('an empty selection is refused, not paid as $0', () => {
    const plan = planReceiptCorrection({ ...base, budLightLines: [] })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.message).toMatch(/nothing to reimburse/i)
    expect(plan.message).toMatch(/[Rr]eject/)
    expect(plan.message).toMatch(/corrected amount/)
  })

  it('an empty selection is still refused when an amount is also supplied', () => {
    const plan = planReceiptCorrection({ ...base, budLightLines: [], overrideTotal: 58.45 })
    expect(plan.ok).toBe(false)
  })

  it('line corrections are refused on a rejection', () => {
    const plan = planReceiptCorrection({ ...base, decision: 'rejected', budLightLines: [0] })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.message).toMatch(/only apply when approving/)
  })

  it('bad indices propagate the validation message', () => {
    const plan = planReceiptCorrection({ ...base, budLightLines: [99] })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.message).toMatch(/line 99/)
  })
})

describe('both bud_light_lines and override_total: the declared precedence', () => {
  it('AMOUNT_PRECEDENCE is override_total', () => {
    expect(AMOUNT_PRECEDENCE).toBe('override_total')
  })

  it('the ticks set the classification, the typed amount sets the money', () => {
    const plan = planReceiptCorrection({
      ocrJson: METRO,
      budLightLines: [0, 2],
      overrideTotal: 43.58,     // 37.90 grossed up at Quebec 14.975%, off the paper
      decision: 'approved'
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.amountSource).toBe('override_total')
    expect(plan.amount).toBe(43.58)
    // The correction is still applied and still persisted: that is the whole point.
    expect(plan.changed).toBe(true)
    expect(plan.correction?.indices).toEqual([0, 2])
    // And the figure the ticks alone would have produced is still available, so the
    // disagreement can be reported and audited instead of hidden.
    expect(plan.correction?.recomputed.total).toBeCloseTo(37.9, 2)
  })

  it('override_total alone still works exactly as before', () => {
    const plan = planReceiptCorrection({
      ocrJson: METRO, budLightLines: undefined, overrideTotal: 60, decision: 'approved'
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.correction).toBeNull()
    expect(plan.amountSource).toBe('override_total')
    expect(plan.amount).toBe(60)
  })
})

describe('what gets persisted', () => {
  const corr = applyBudLightCorrection(METRO, [0, 2])
  const stored = annotateCorrectedOcr(METRO, corr, {
    at: '2026-08-10T12:00:00.000Z',
    by: 'robin.graham@ilovesalt.com',
    amountSource: 'corrected_lines',
    amountStored: 37.9,
    reason: 'seltzer water is not Bud Light beer'
  })

  it('lines[].is_bud_light holds the CORRECTED flags', () => {
    expect(currentBudLightFlags(stored)).toEqual([true, false, true, false, false, false, false, false])
    expect(currentBudLightIndices(stored)).toEqual([0, 2])
    // The rest of each line is untouched.
    expect(ocrLineObjects(stored)?.[4].desc).toBe('BUDLISELT.EAU P. 6X355')
    expect(ocrLineObjects(stored)?.[4].total).toBe(12.95)
  })

  it('the AI original is kept for training and is not overwritten by a second pass', () => {
    const model = stored.model_classification as Record<string, unknown>
    expect(model.bud_light_total_incl_tax).toBe(58.45)
    expect((model.lines as Array<{ index: number; is_bud_light: boolean }>).filter(l => l.is_bud_light).map(l => l.index))
      .toEqual([0, 2, 4])

    // Second correction on the already-corrected object: the AI snapshot survives.
    const again = applyBudLightCorrection(stored, [0])
    const stored2 = annotateCorrectedOcr(stored, again, {
      at: '2026-08-11T09:00:00.000Z', by: 'robin.graham@ilovesalt.com',
      amountSource: 'corrected_lines', amountStored: 22.95, reason: 'lime pack was returned'
    })
    expect(stored2.model_classification).toEqual(stored.model_classification)
    expect(currentBudLightIndices(stored2)).toEqual([0])
  })

  it('the stored object is self-consistent: recomputing from it gives the same amount', () => {
    // ENGINEERING-RULES 7.2, one source of truth for money: reading the record back
    // must not produce a different number from the one that was paid.
    expect(recomputeBudLightTotal(stored as never).total).toBeCloseTo(corr.recomputed.total, 2)
    expect(stored.bud_light_total_incl_tax).toBeCloseTo(37.9, 2)
  })

  it('admin_classification records who, which lines and both totals', () => {
    const a = stored.admin_classification as Record<string, unknown>
    expect(a.bud_light_lines).toEqual([0, 2])
    expect(a.previous_bud_light_lines).toEqual([0, 2, 4])
    expect(a.lines_removed).toEqual([4])
    expect(a.recomputed_total).toBeCloseTo(37.9, 2)
    expect(a.previous_total).toBeCloseTo(58.45, 2)
    expect(a.corrected_by).toBe('robin.graham@ilovesalt.com')
    expect(a.amount_stored).toBe(37.9)
  })
})

describe('the audit row', () => {
  const corr = applyBudLightCorrection(METRO, [0, 2])
  const audit = buildCorrectionAudit({
    previousStatus: 'review',
    decision: 'approved',
    previousTotal: 58.45,
    storedTotal: 37.9,
    correction: corr,
    overrideTotal: null,
    amountSource: 'corrected_lines',
    reason: 'seltzer water is not Bud Light beer',
    actorLabel: 'robin.graham@ilovesalt.com'
  })

  it('carries BOTH totals', () => {
    expect(audit.before_json.bud_light_total_incl_tax).toBe(58.45)
    expect(audit.after_json.bud_light_total_incl_tax).toBe(37.9)
    expect(audit.before_json.recomputed_from_lines).toBeCloseTo(58.45, 2)
    expect(audit.after_json.recomputed_from_lines).toBeCloseTo(37.9, 2)
  })

  it('carries which lines changed, with the descriptions', () => {
    expect(audit.after_json.bud_light_lines).toEqual([0, 2])
    expect(audit.before_json.bud_light_lines).toEqual([0, 2, 4])
    expect(audit.after_json.lines_removed).toEqual([4])
    expect(audit.after_json.lines_added).toEqual([])
    expect(JSON.stringify(audit.after_json.changed_lines)).toContain('BUDLISELT.EAU P. 6X355')
  })

  it('records the amount source so an override cannot disagree silently', () => {
    expect(audit.after_json.amount_source).toBe('corrected_lines')
    const withOverride = buildCorrectionAudit({
      previousStatus: 'review', decision: 'approved', previousTotal: 58.45, storedTotal: 43.58,
      correction: corr, overrideTotal: 43.58, amountSource: 'override_total',
      reason: 'tax-inclusive figure off the paper', actorLabel: 'robin.graham@ilovesalt.com'
    })
    expect(withOverride.after_json.amount_source).toBe('override_total')
    expect(withOverride.after_json.override_total).toBe(43.58)
    expect(withOverride.after_json.bud_light_total_incl_tax).toBe(43.58)
    // The figure the lines alone would have produced is still on the record.
    expect(withOverride.after_json.recomputed_from_lines).toBeCloseTo(37.9, 2)
  })

  it('has exactly the payload keys audit_log has, and no `meta`', () => {
    // audit_log is (actor_id, actor_role, entity, entity_id, action, before_json,
    // after_json). PostgREST drops an unknown key without an error, so a `meta`
    // field would lose the detail silently.
    expect(Object.keys(audit).sort()).toEqual(['action', 'after_json', 'before_json'])
    expect('meta' in audit).toBe(false)
  })
})

describe('degenerate ocr_json does not throw', () => {
  it('applyBudLightCorrection on junk returns an empty, zero correction', () => {
    for (const junk of [null, undefined, 42, 'text', [], {}, { lines: null }]) {
      const corr = applyBudLightCorrection(junk, [0, 1])
      expect(corr.changed).toEqual([])
      expect(corr.recomputed.total).toBe(0)
    }
  })

  it('a line object that is not an object is tolerated', () => {
    const weird = { lines: [null, { desc: 'BUD LIGHT', total: 10, is_bud_light: false }], grand_total: 10 }
    const corr = applyBudLightCorrection(weird, [1])
    expect(corr.added).toEqual([1])
    expect(corr.recomputed.total).toBeCloseTo(10, 2)
  })
})

describe('decide route wiring', () => {
  it('accepts bud_light_lines and recomputes on the server', () => {
    expect(ROUTE).toMatch(/bud_light_lines/)
    expect(ROUTE).toMatch(/planReceiptCorrection\(/)
    expect(ROUTE).toMatch(/annotateCorrectedOcr\(/)
    expect(ROUTE).toMatch(/buildCorrectionAudit\(/)
    // ocr_json has to be loaded for the server to recompute from it.
    expect(ROUTE).toMatch(/select\('bam_id, cohort_id, period, bud_light_total_incl_tax, status, ocr_json'\)/)
  })

  it('never takes a total from the request body', () => {
    // The only client-supplied amount is override_total, which is parsed and capped.
    expect(ROUTE).not.toMatch(/body\.(bud_light_total|recomputed_total|corrected_total)/)
    expect(ROUTE).toMatch(/MAX_OVERRIDE_CAD/)
    // No tax arithmetic in the route: that lives in recomputeBudLightTotal only.
    expect(ROUTE).not.toMatch(/0\.14975|1\.13|\* \(1 \+ /)
  })

  it('reads the corrected flags back after writing them', () => {
    expect(ROUTE).toMatch(/currentBudLightFlags\(updated\[0\]\.ocr_json\)/)
    expect(ROUTE).toMatch(/did not persist/)
  })

  it('still rolls back on every downstream money failure, and restores ocr_json', () => {
    const rollbacks = ROUTE.match(/await rollback\(/g) ?? []
    // Four now, not the ten this once counted. The six ledger failure paths (cohort
    // unreadable, cohort numbers unusable, month sum, prior ledger, ledger write, row
    // count, read-back) collapsed into ONE call site when the arithmetic moved to
    // lib/recompute-ledger: that function returns a single error and the route rolls
    // back on it. Fewer call sites, same coverage, and one place that can forget.
    //
    // What matters is that no ledger failure can reach the client without an undo,
    // which the two assertions after this one check directly.
    expect(rollbacks.length).toBeGreaterThanOrEqual(4)
    expect(ROUTE).toMatch(/restoreOcrJson/)
    expect(ROUTE).toMatch(/payload\.ocr_json = previousOcrJson/)
  })

  it('every failure of the shared ledger function reaches a rollback', () => {
    // The ledger step has exactly one exit for failure, and it must undo the decision.
    // Written as one span so a future edit cannot insert an early return between the
    // call and the rollback: the two have to stay adjacent for this to match.
    expect(ROUTE).toMatch(
      /await recomputeLedgerForPeriod\(admin, \{[\s\S]{0,300}?if \(!ledger\.ok\) \{[\s\S]{0,200}?await rollback\(ledger\.error\)/
    )
    // And the route must not carry a second, private copy of the arithmetic again.
    expect(ROUTE).not.toMatch(/computeMonthlyReimbursement/)
    // Match CODE, not prose: the route's docblock still mentions the ledger upsert,
    // and an assertion that a comment cannot mention a table is not a useful one.
    expect(ROUTE).not.toMatch(/from\('reimbursement_ledger'\)/)
    expect(ROUTE).not.toMatch(/entitlement_cad/)
  })

  it('keeps the reason requirement, and the ledger read-back still exists', () => {
    expect(ROUTE).toMatch(/reasonProblem\(reason\)/)
    // The read-back is now inside the shared function rather than inline in the route.
    // It is the assertion that stops a write reporting success while storing a
    // different number, so it is checked where it lives.
    expect(LEDGER).toMatch(/ledger read-back mismatch/)
    expect(LEDGER).toMatch(/persistedPaid/)
    expect(LEDGER).toMatch(/Math\.abs\(persistedPaid - out\.paidThisMonth\) > 0\.005/)
  })

  it('the shared ledger function fails closed on every input it cannot trust', () => {
    // Each of these was a separate guarded branch in the route before the move. They
    // are the reason an unreadable cohort is never quietly paid the $150 default.
    expect(LEDGER).toMatch(/cohort policy could not be read/)
    expect(LEDGER).toMatch(/is not a usable number/)
    expect(LEDGER).toMatch(/neither forfeit nor accumulate/)
    expect(LEDGER).toMatch(/receipts could not be summed/)
    expect(LEDGER).toMatch(/prior ledger unreadable/)
    expect(LEDGER).toMatch(/ledger write failed/)
    expect(LEDGER).toMatch(/expected 1/)
  })

  it('reports the amount source back to the caller', () => {
    expect(ROUTE).toMatch(/amount_source: plan\.amountSource/)
    expect(ROUTE).toMatch(/classification_changed/)
    expect(ROUTE).toMatch(/recomputed_total: correction\.recomputed\.total/)
  })
})

describe('admin page wiring', () => {
  it('the BL? cell is a control, and there is a reset', () => {
    expect(PAGE).toMatch(/toggleLine\(r, li\)/)
    expect(PAGE).toMatch(/aria-pressed=\{on\}/)
    expect(PAGE).toMatch(/Reset to what the AI read/)
  })

  it('the preview is labelled as a preview and shows the original alongside', () => {
    expect(PAGE).toMatch(/Preview, server recomputes/)
    expect(PAGE).toMatch(/On record now/)
    expect(PAGE).toMatch(/applyBudLightCorrection/)
  })

  it('the corrected amount field is outside the approve confirmation', () => {
    const approveCard = PAGE.slice(PAGE.indexOf("confirming === 'approve'"))
    expect(approveCard).not.toMatch(/setAmountOverride\(e\.target\.value/)
    expect(PAGE).toMatch(/Corrected amount, optional fallback/)
    expect(PAGE).toMatch(/fallback/i)
  })

  it('sends bud_light_lines only when a tick moved', () => {
    expect(PAGE).toMatch(/bud_light_lines: budLightLines/)
    expect(PAGE).toMatch(/corr\.changed\.length > 0/)
  })

  it('failures use the error toast, never a green badge', () => {
    expect(PAGE).toMatch(/notify\('error'/)
    expect(PAGE).not.toMatch(/badge-green.*Decision failed/)
  })

  it('no em dash in the strings this feature added', () => {
    // The placeholder for an empty cell is the pre-existing em dash and is left as
    // it is; nothing new may introduce one.
    const added = [
      'Click a line to include or exclude it',
      'Preview, server recomputes',
      'Corrected amount, optional fallback',
      'Reset to what the AI read'
    ]
    for (const s of added) {
      expect(PAGE).toContain(s)
      expect(s.includes('—')).toBe(false)
    }
  })
})
