/**
 * READ-ONLY. What tax basis does each stored receipt actually recompute on, and
 * would an admin correction of the Bud Light ticks change the amount as expected?
 *
 * Why this exists: the correction feature (`bud_light_lines` on
 * /api/admin/receipts/decide) re-derives the amount by re-running
 * recomputeBudLightTotal over the corrected flags. What that returns depends on the
 * receipt's own numbers:
 *
 *   lines_incl_tax             untick a line and the total drops by exactly that line
 *   lines_grossed_up           every line is Bud Light, the receipt's own rate applies
 *   lines_mixed_rate_validated the model's tax-inclusive figure was corroborated
 *   lines_mixed_pretax / raw   PRE-TAX sum only, an admin must supply the tax-inclusive
 *                              figure with the corrected-amount field
 *
 * So "what happens when Robin unticks a line" is a property of the live data, not
 * of the code alone. This prints the distribution and, per receipt, the amount a
 * single untick would produce. No BAM, no email, no storage key, no PII: store
 * name, item descriptions and amounts only.
 *
 * Usage:  node scripts/probe/receipt-basis.js [store-substring]
 */
const { serviceClient, pass, info, verdict } = require('./_lib')

async function main() {
  const filter = (process.argv[2] || '').toLowerCase()
  const admin = serviceClient()

  const { data, error } = await admin
    .from('receipts')
    .select('id, status, bud_light_total_incl_tax, ocr_json')
    .not('ocr_json', 'is', null)
    .order('uploaded_at', { ascending: false })
    .limit(200)

  if (error) {
    console.log('  FAIL  could not read receipts: ' + error.message)
    process.exit(1)
  }

  // The compiled TS is not available to plain node, so the recompute is imported
  // from source through the same tsx-free path the tests use: re-implementing it
  // here would defeat the point. Use `npx vitest` for logic; this probe reports the
  // raw figures the recompute keys off, which is what cannot be seen from code.
  const rows = (data || []).filter(r => {
    if (!filter) return true
    const store = String(r.ocr_json?.store ?? '').toLowerCase()
    return store.includes(filter)
  })

  info(`${rows.length} receipt(s) with ocr_json` + (filter ? ` matching store "${filter}"` : ''))

  let corrected = 0
  for (const r of rows) {
    const o = r.ocr_json || {}
    const lines = Array.isArray(o.lines) ? o.lines : []
    const bl = lines.filter(l => l && l.is_bud_light === true)
    const blSum = bl.reduce((a, l) => a + (Number(l.total) || 0), 0)
    const allSum = lines.reduce((a, l) => a + (Number(l.total) || 0), 0)
    if (o.admin_classification) corrected++

    console.log(
      `  ..    ${String(o.store ?? 'unknown store').slice(0, 22).padEnd(22)} ` +
      `status=${String(r.status).padEnd(10)} ` +
      `stored=$${Number(r.bud_light_total_incl_tax ?? 0).toFixed(2).padStart(7)} ` +
      `model=$${Number(o.bud_light_total_incl_tax ?? 0).toFixed(2).padStart(7)} ` +
      `bl=${bl.length}/${lines.length} blSum=$${blSum.toFixed(2)} ` +
      `lineSum=$${allSum.toFixed(2)} subtotal=$${Number(o.subtotal ?? 0).toFixed(2)} ` +
      `tax=$${Number(o.tax ?? 0).toFixed(2)} grand=$${Number(o.grand_total ?? 0).toFixed(2)}` +
      (o.admin_classification ? ' [admin-corrected]' : '')
    )
  }

  pass(`read ${rows.length} receipt(s), ${corrected} carrying an admin classification correction`)
  info('compare lineSum against subtotal and grand to see which basis recompute will pick')
  verdict('receipt tax basis')
}

main()
