/**
 * Closes admin notifications whose work is already done.
 *
 * The bell only ever counted up. A notification became read when somebody clicked it, and
 * nothing ever closed one because the receipt behind it had been decided. On 2026-09-08
 * it said 27 unread and 13 of those were finished, nine of them cleared by a script an
 * hour earlier. A counter that is mostly wrong stops meaning "waiting for you" and starts
 * meaning "things that have ever happened", and then nobody opens it.
 *
 * The code now closes them as it goes (lib/notify-admin.ts syncAdminNotifications, called
 * from the decide route and the OCR route). This is the one-time pass over what was
 * already there.
 *
 * IT DECIDES NOTHING AND MOVES NO MONEY. It sets `read` on notification rows. It never
 * touches a receipt, an amount, a status or a ledger. The worst it can do is hide a
 * reminder about work that is finished, and it only does that after checking the receipts
 * itself.
 *
 * It also backfills bam_id on the old `ocr_failed` rows. Those were written without one,
 * so the bell could not say whose receipt had failed and nothing could ever match them.
 * The receipt id is in the body text, which is the only handle those rows have.
 *
 * Dry run:  node scripts/probe/fix-close-stale-notifications.js
 * Apply:    node scripts/probe/fix-close-stale-notifications.js --apply
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const APPLY = process.argv.includes('--apply')

async function main() {
  const db = serviceClient()
  const { syncAdminNotifications } = loadTs('lib/notify-admin.ts')

  const { data: notes, error: nErr } = await db.from('admin_notifications')
    .select('id, type, title, body, bam_id, period, created_at').eq('read', false)
  if (nErr) { fail(`notifications unreadable: ${nErr.message}`); return verdict('close stale notifications') }
  if (!notes?.length) { pass('nothing unread'); return verdict('close stale notifications') }
  info(`${notes.length} unread`)

  const { data: receipts, error: rErr } = await db.from('receipts').select('id, bam_id, period, status')
  if (rErr) { fail(`receipts unreadable: ${rErr.message}`); return verdict('close stale notifications') }

  // 1. The orphaned ocr_failed rows. Match the id prefix their body quotes.
  const orphans = notes.filter(n => n.type === 'ocr_failed' && !n.bam_id)
  for (const n of orphans) {
    const m = String(n.body ?? '').match(/\b([0-9a-f]{8})\b/)
    const owner = m ? receipts.find(r => r.id.startsWith(m[1])) : null
    if (!owner) { info(`ocr_failed ${n.id.slice(0, 8)}: no receipt id in the body, leaving it`); continue }
    info(`ocr_failed ${n.id.slice(0, 8)} belongs to receipt ${m[1]} (status ${owner.status})`)
    // Applied to the in-memory row either way, so the DRY RUN reports the same plan the
    // apply will carry out. It did not, and the dry run silently missed a whole step.
    n.bam_id = owner.bam_id
    n.period = owner.period
    if (!APPLY) continue
    const { error } = await db.from('admin_notifications')
      .update({ bam_id: owner.bam_id, period: owner.period }).eq('id', n.id)
    if (error) { fail(`  backfill failed: ${error.message}`); continue }
    const { data: back } = await db.from('admin_notifications').select('bam_id').eq('id', n.id).single()
    if (back?.bam_id !== owner.bam_id) { fail('  backfill did not read back'); continue }
    pass('  now says whose receipt it was')
  }

  // 2. Close what is finished, through the same function the app uses, so the probe and
  //    the running system cannot disagree about what "finished" means.
  const pairs = [...new Set(
    notes.filter(n => n.bam_id && n.period).map(n => `${n.bam_id}|${n.period}`)
  )]
  let wouldClose = 0
  const bams = new Map()
  const { data: bamRows } = await db.from('bams').select('id, first_name, last_name')
  for (const b of bamRows ?? []) bams.set(b.id, `${b.first_name} ${b.last_name}`)

  for (const key of pairs) {
    const [bamId, period] = key.split('|')
    const who = bams.get(bamId) ?? bamId.slice(0, 8)
    const open = receipts.filter(r => r.bam_id === bamId && r.period === period)
    const mine = notes.filter(n => n.bam_id === bamId && n.period === period && (n.type === 'receipt_review' || n.type === 'ocr_failed'))
    if (!mine.length) continue

    const stillOpen = mine.filter(n => {
      const state = n.type === 'receipt_review' ? 'review' : 'ocr_failed'
      return open.some(r => r.status === state)
    })
    const done = mine.length - stillOpen.length
    if (done === 0) { info(`${who}: ${mine.length} still genuinely waiting`); continue }

    wouldClose += done
    info(`${who} ${period}: ${done} finished, ${stillOpen.length} still waiting`)
    if (!APPLY) continue

    const out = await syncAdminNotifications(db, { bamId, period })
    if (!out.ok) { fail(`  ${out.error}`); continue }
    pass(`  closed ${out.closed}`)
  }

  /*
   * 3. Older copies of an ocr_failed that is still open.
   *
   * Jackson Bennett's one failed receipt produced two identical notifications, three days
   * apart, because a retry that failed again was written as a new item. Keep the newest
   * and close the rest, which is the rule new ones now follow (hasOpenNotification).
   *
   * Only ocr_failed. A BAM can genuinely have two receipts in review at once, and Emma
   * Crowder and Eesha Nandha both did, so collapsing receipt_review would hide real work.
   */
  const openFailures = notes.filter(n => n.type === 'ocr_failed' && n.bam_id && n.period)
  const seen = new Map()
  for (const n of openFailures.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    const key = `${n.bam_id}|${n.period}`
    if (!seen.has(key)) { seen.set(key, n); continue }
    const who = bams.get(n.bam_id) ?? n.bam_id.slice(0, 8)
    info(`${who}: an older duplicate of the same failed read, from ${String(n.created_at).slice(0, 10)}`)
    wouldClose++
    if (!APPLY) continue
    const { error } = await db.from('admin_notifications').update({ read: true }).eq('id', n.id)
    if (error) { fail(`  could not close it: ${error.message}`); continue }
    pass('  closed the duplicate, the newer one stays open')
  }

  info('')
  const shortfalls = notes.filter(n => n.type === 'shortfall')
  if (shortfalls.length) {
    // Not closed here: a shortfall is about the month, not about one receipt, and only
    // Robin knows whether she has dealt with it. Reported so the duplicates are visible.
    const byBam = {}
    for (const n of shortfalls) byBam[n.bam_id] = (byBam[n.bam_id] ?? 0) + 1
    const dupes = Object.entries(byBam).filter(([, c]) => c > 1)
    info(`${shortfalls.length} unread shortfall notice(s), left alone: only Robin knows if she has acted`)
    for (const [id, c] of dupes) info(`   ${bams.get(id) ?? id.slice(0, 8)} has ${c} for the same month; new ones are now deduplicated`)
  }

  if (!APPLY) {
    info(`${wouldClose} notification(s) are for work already done. Re-run with --apply.`)
    return verdict('close stale notifications')
  }

  const { data: after, error: aErr } = await db.from('admin_notifications').select('id').eq('read', false)
  if (aErr) fail(`could not read back the unread count: ${aErr.message}`)
  else pass(`the bell now says ${(after ?? []).length}, down from ${notes.length}`)

  verdict('close stale notifications')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('close stale notifications') })
