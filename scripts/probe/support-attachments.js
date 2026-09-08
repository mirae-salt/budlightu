/**
 * Q: Can a support thread actually carry a file, end to end?
 *
 * Theo Cliche, 2026-09-04: "It also does not allow me to send you pictures on this log."
 * He was in the middle of a thread about a receipt that would not upload, and the one
 * thing that would have explained it was the one thing the thread could not hold.
 *
 * Four things have to be true, and three of them are invisible from the screen:
 *   1. the columns exist (migration 0034)
 *   2. the `support` bucket exists, is PRIVATE, and carries its own size and type limits,
 *      because the browser uploads straight to Storage and our code never sees the bytes
 *   3. a signed upload URL can actually be minted
 *   4. keys are shaped so one student's file cannot be read by another
 *
 * Read only, except that (3) writes and then deletes one tiny probe object, because a
 * signed URL that cannot be used is not a working upload path. It is removed again and the
 * script says so.
 *
 * Usage: node scripts/probe/support-attachments.js
 */
const { serviceClient, pass, fail, info, verdict, loadTs } = require('./_lib')

const PROBE_PREFIX = '_probe'

async function main() {
  const db = serviceClient()
  const { keyBelongsToBam, buildAttachmentKey, SUPPORT_BUCKET } = loadTs('lib/support-attachment.ts')

  // 1. columns
  const { error: colErr } = await db.from('portal_question_messages')
    .select('attachment_key, attachment_mime, attachment_bytes, attachment_name').limit(1)
  if (colErr) {
    fail(`migration 0034 is not applied: ${colErr.message}`)
    info('the support thread reads these columns, so the portal history page 500s until it is')
    return verdict('support attachments')
  }
  pass('the attachment columns exist')

  // 2. the bucket, and the limits that live on it rather than in our code
  const { data: buckets, error: bErr } = await db.storage.listBuckets()
  if (bErr) { fail(`buckets unreadable: ${bErr.message}`); return verdict('support attachments') }
  const bucket = (buckets ?? []).find(b => b.name === SUPPORT_BUCKET)
  if (!bucket) {
    fail(`there is no "${SUPPORT_BUCKET}" bucket, so nothing can be attached`)
    return verdict('support attachments')
  }
  if (bucket.public) fail('the support bucket is PUBLIC: anyone with a key could read a student attachment')
  else pass('the support bucket is private')

  if (!bucket.file_size_limit) {
    fail('the bucket has no size limit, and our code never sees the bytes, so nothing enforces one')
  } else {
    pass(`bucket size limit ${(bucket.file_size_limit / 1024 / 1024).toFixed(0)} MB, enforced by Storage`)
  }
  if (!bucket.allowed_mime_types?.length) {
    fail('the bucket has no mime allowlist, and our code never sees the bytes, so nothing enforces one')
  } else {
    pass(`bucket accepts ${bucket.allowed_mime_types.join(', ')}`)
  }

  // 3. can a signed upload actually be minted and used
  const key = `${PROBE_PREFIX}/${Date.now()}.png`
  const { data: signed, error: sErr } = await db.storage.from(SUPPORT_BUCKET).createSignedUploadUrl(key)
  if (sErr || !signed) {
    fail(`could not mint a signed upload URL: ${sErr?.message ?? 'no data'}`)
    return verdict('support attachments')
  }
  pass('a signed upload URL can be minted')

  // A one-pixel PNG, so the mime allowlist is exercised for real.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const { error: upErr } = await db.storage.from(SUPPORT_BUCKET)
    .uploadToSignedUrl(key, signed.token, png, { contentType: 'image/png' })
  if (upErr) {
    fail(`the signed URL could not be used: ${upErr.message}`)
  } else {
    pass('a file uploaded through it, so the path the browser takes works')
    const { error: delErr } = await db.storage.from(SUPPORT_BUCKET).remove([key])
    if (delErr) fail(`the probe object could not be removed (${key}): ${delErr.message}`)
    else info('probe object removed, nothing left behind')
  }

  // 4. the rule that decides whose file is whose
  const a = '11111111-1111-1111-1111-111111111111'
  const b = '22222222-2222-2222-2222-222222222222'
  const mine = buildAttachmentKey({ bamId: a, questionId: 'q', mime: 'image/jpeg', random: 'r' })
  if (keyBelongsToBam(mine, a) && !keyBelongsToBam(mine, b) && !keyBelongsToBam(mine, '')) {
    pass('a key is readable by its owner and by nobody else')
  } else {
    fail('keyBelongsToBam does not separate one student from another')
  }

  // What is actually in there. Useful once students start using it, and it is the only
  // way to notice a growing pile of orphans.
  const { data: withFiles, error: wErr } = await db.from('portal_question_messages')
    .select('attachment_key, attachment_bytes').not('attachment_key', 'is', null)
  if (wErr) info(`could not count stored attachments: ${wErr.message}`)
  else {
    const total = (withFiles ?? []).reduce((s, r) => s + Number(r.attachment_bytes ?? 0), 0)
    info(`${(withFiles ?? []).length} message(s) carry a file, ${(total / 1_000_000).toFixed(1)} MB in total`)
  }

  verdict('support attachments')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('support attachments') })
