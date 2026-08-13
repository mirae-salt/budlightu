/**
 * Q: What is in a student's notification bell, and is anything in there wrong?
 *
 * The bell is a status board, so the failure people would actually report is "it is empty" or
 * "it says something odd". Both are cheaper to check here than to reproduce by signing in.
 *
 * Checks three things the code cannot check for itself:
 *   - the table and its columns exist (0028 applied)
 *   - no stored `link` points anywhere but /portal/, because a student following an /admin
 *     link is bounced by the middleware and the portal looks broken
 *   - no row belongs to a bam_id that no longer exists
 *
 * CANNOT check RLS. This runs as the service role, which bypasses it. The column grants are
 * verifiable though, and they are the half RLS cannot express: a student may UPDATE `read` and
 * nothing else. Confirm those from the SQL editor if they are ever in doubt.
 *
 * Usage: node scripts/probe/bam-notifications.js
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

const COLUMNS = 'id, bam_id, type, title, body, link, period, read, created_at'

async function main() {
  const db = serviceClient()

  const { data: rows, error } = await db
    .from('bam_notifications')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    fail(`bam_notifications unreadable: ${error.message}`)
    info('if this says the table is missing, migration 0028 has not been applied')
    return verdict('BAM notifications')
  }
  pass(`table readable, every column in ${JSON.stringify(COLUMNS)} resolves`)

  const list = rows ?? []
  if (list.length === 0) {
    info('no notifications yet. Nothing has approved a receipt or sent an invoice.')
    return verdict('BAM notifications')
  }

  // Who has what. A student with 40 unread means the bell has become an inbox, which is the
  // thing it was explicitly not supposed to become.
  const { data: bams } = await db.from('bams').select('id, email')
  const emailById = new Map((bams ?? []).map(b => [b.id, b.email]))

  const byBam = new Map()
  for (const r of list) {
    const cur = byBam.get(r.bam_id) ?? { total: 0, unread: 0 }
    cur.total++
    if (!r.read) cur.unread++
    byBam.set(r.bam_id, cur)
  }
  for (const [bamId, c] of byBam) {
    const who = emailById.get(bamId)
    if (!who) fail(`${c.total} notification(s) belong to bam_id ${bamId}, which is not on the roster`)
    else info(`${String(who).padEnd(32)} ${c.total} total, ${c.unread} unread`)
  }

  const badLinks = list.filter(r => r.link && !String(r.link).startsWith('/portal/'))
  if (badLinks.length > 0) {
    for (const r of badLinks) fail(`${r.type} links to ${JSON.stringify(r.link)}, which is not a portal path`)
  } else {
    pass('every stored link is a portal path')
  }

  const noTitle = list.filter(r => !String(r.title ?? '').trim())
  if (noTitle.length > 0) fail(`${noTitle.length} notification(s) have no title, so the panel shows a blank row`)
  else pass('every notification has a title')

  info('read-only: nothing was written')
  info('RLS is NOT covered here; the service role bypasses it')
  verdict('BAM notifications')
}
main()
