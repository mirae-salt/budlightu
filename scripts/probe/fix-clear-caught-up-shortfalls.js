/**
 * Clears shortfall warnings whose period has since caught back up past the floor.
 *
 * flagShortfall fires on the FIRST receipt that puts a period below the floor, then
 * refuses to touch that period again ("already flagged for this period"). So a BAM
 * who submits a light receipt and tops up later in the same month keeps the "warned"
 * badge on the admin dashboard forever, even once the month is over the cap.
 *
 * Found 2026-09-14 from Elizabeth Bennett's dashboard row: warned at $38.99 on her
 * first receipt (2026-09-04), $182.57 for the month by her third (2026-09-05), still
 * showing "1x warn" days later. A scan of every recorded warning found 13 of 24 in
 * this same stale state.
 *
 * This is the one-off cleanup for the rows that already exist. The code fix that
 * stops new ones from accumulating is lib/shortfall-warning.ts's
 * resolveCaughtUpShortfall, called from app/api/receipts/ocr/route.ts and
 * app/api/admin/receipts/decide/route.ts wherever flagShortfall is called today.
 *
 * ONLY clears a warning that was never sent (sent_at is null) -- an emailed warning
 * already reached Robin and is a record of something that happened, same rule as not
 * deleting audit_log.
 *
 * Usage:
 *   node scripts/probe/fix-clear-caught-up-shortfalls.js            count what would go
 *   node scripts/probe/fix-clear-caught-up-shortfalls.js --apply    delete it
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')
const { resolveCaughtUpShortfall } = loadTs('lib/shortfall-warning.ts')

const APPLY = process.argv.includes('--apply')

async function main() {
  const db = serviceClient()

  const { data: warnings, error: wErr } = await db
    .from('bam_warnings')
    .select('id, bam_id, cohort_id, period, spent, sent_at')
  if (wErr) { fail(`bam_warnings unreadable: ${wErr.message}`); return verdict('clear caught-up shortfalls') }

  const { data: receipts, error: rErr } = await db
    .from('receipts')
    .select('bam_id, period, bud_light_total_incl_tax, status')
    .in('status', ['auto_pass', 'approved'])
  if (rErr) { fail(`receipts unreadable: ${rErr.message}`); return verdict('clear caught-up shortfalls') }

  const totals = {}
  for (const r of receipts ?? []) {
    const key = `${r.bam_id}|${String(r.period).slice(0, 7)}`
    totals[key] = (totals[key] ?? 0) + (r.bud_light_total_incl_tax ?? 0)
  }

  // Same floor the dashboard and flagShortfall itself use.
  const { SHORTFALL_WARN_BELOW_CAD } = loadTs('lib/policy.ts')

  const stale = (warnings ?? []).filter(w => {
    const key = `${w.bam_id}|${String(w.period).slice(0, 7)}`
    const currentTotal = totals[key] ?? 0
    return currentTotal >= SHORTFALL_WARN_BELOW_CAD
  })

  info(`${(warnings ?? []).length} warning row(s) total; ${stale.length} now show a period total at or above the floor`)

  let cleared = 0
  let alreadySent = 0
  for (const w of stale) {
    if (w.sent_at) { alreadySent++; info(`  KEEP (sent) ${w.bam_id} ${w.period} — warned $${w.spent}, emailed ${w.sent_at}`); continue }

    if (!APPLY) {
      info(`  would clear ${w.bam_id} ${w.period} — warned $${w.spent}, never sent`)
      continue
    }
    const result = await resolveCaughtUpShortfall(db, { bamId: w.bam_id, cohortId: w.cohort_id, period: w.period })
    if (!result.ok) { fail(`${w.bam_id} ${w.period}: ${result.error}`); continue }
    if (result.cleared) { pass(`cleared ${w.bam_id} ${w.period}`); cleared++ }
    else { info(`  no-op ${w.bam_id} ${w.period} (already gone or since sent)`) }
  }

  if (alreadySent > 0) {
    info(`${alreadySent} stale-looking row(s) were already emailed and were left alone.`)
  }

  if (!APPLY) {
    info('')
    info('DRY RUN. Re-run with --apply.')
    return verdict('clear caught-up shortfalls')
  }

  // Read back.
  const { data: remaining, error: remErr } = await db
    .from('bam_warnings')
    .select('bam_id, cohort_id, period, sent_at')
  if (remErr) { fail(`read-back failed: ${remErr.message}`); return verdict('clear caught-up shortfalls') }

  let leftoverStale = 0
  for (const w of remaining ?? []) {
    if (w.sent_at) continue
    const key = `${w.bam_id}|${String(w.period).slice(0, 7)}`
    if ((totals[key] ?? 0) >= SHORTFALL_WARN_BELOW_CAD) leftoverStale++
  }
  if (leftoverStale > 0) fail(`${leftoverStale} stale unsent warning(s) still remain after the pass`)
  else pass(`clean: ${cleared} row(s) cleared, no stale unsent warnings remain`)

  verdict('clear caught-up shortfalls')
}
main()
