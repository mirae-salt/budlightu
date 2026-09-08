/**
 * POST /api/portal/support/attachment   { question_id, mime }  -> { key, token, bucket }
 * GET  /api/portal/support/attachment?key=...                   -> the file
 *
 * The upload does NOT come through here. POST hands back a short-lived signed URL and the
 * browser PUTs the file straight to Supabase Storage, because Vercel refuses a function
 * request body over 4.5 MB and that is the exact failure this whole feature exists to help
 * people report. Only JSON crosses this route.
 *
 * Which means this route never sees the bytes and cannot vet them. The `support` bucket
 * carries the real limits (private, 20 MB, image and PDF only) and Storage applies them
 * whatever a client sends. What this route does control is WHERE a file may be written and
 * WHO may read it back.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { getSessionUser, isDevBypass, requireAdmin } from '../../../../../lib/admin-auth'
import { devBypassBam } from '../../../../../lib/dev-bam'
import {
  SUPPORT_BUCKET,
  SUPPORT_ALLOWED_MIME,
  buildAttachmentKey,
  keyBelongsToBam,
  safeDownloadName
} from '../../../../../lib/support-attachment'

/** The signed-in student's bam id, or null. */
async function callerBamId(db: ReturnType<typeof serviceClient>): Promise<string | null> {
  if (isDevBypass()) return (await devBypassBam(db))?.id ?? null
  const session = await getSessionUser()
  if (!session.ok) return null
  const { data, error } = await db.from('bams').select('id').eq('auth_user_id', session.user.id).limit(1)
  if (error) {
    console.error('[support/attachment] bam lookup failed:', error.message)
    return null
  }
  return ((data ?? [])[0] as { id: string } | undefined)?.id ?? null
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }
  const b = (body ?? {}) as Record<string, unknown>
  const questionId = typeof b.question_id === 'string' ? b.question_id.trim() : ''
  const mime = typeof b.mime === 'string' ? b.mime.trim().toLowerCase() : ''

  if (!(SUPPORT_ALLOWED_MIME as readonly string[]).includes(mime)) {
    return NextResponse.json(
      { ok: false, message: 'You can attach a photo (JPG, PNG, WebP, HEIC) or a PDF.' },
      { status: 400 }
    )
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  const bamId = await callerBamId(db)
  if (!bamId) return NextResponse.json({ ok: false, message: 'Please sign in again.' }, { status: 401 })

  /*
   * A thread id in a request body is not proof of anything. Without this check, anyone
   * signed in could get a writable URL under someone else's thread.
   *
   * A blank question_id is allowed and means "the thread this message is about to start":
   * the student is on the new-question form and the row does not exist yet. It is still
   * written under their own bam id, so it is their space either way.
   */
  let scope = 'new'
  if (questionId) {
    const { data: own, error } = await db.from('portal_questions')
      .select('id').eq('id', questionId).eq('bam_id', bamId).limit(1)
    if (error) {
      console.error('[support/attachment] ownership check failed:', error.message)
      return NextResponse.json({ ok: false, message: 'Please try again.' }, { status: 503 })
    }
    if ((own ?? []).length === 0) {
      return NextResponse.json({ ok: false, message: 'That thread is not yours.' }, { status: 403 })
    }
    scope = questionId
  }

  const key = buildAttachmentKey({ bamId, questionId: scope, mime })
  const { data, error } = await db.storage.from(SUPPORT_BUCKET).createSignedUploadUrl(key)
  if (error || !data) {
    console.error('[support/attachment] could not sign an upload:', error?.message)
    return NextResponse.json(
      { ok: false, message: 'We could not start that upload. Please try again.' },
      { status: 503 }
    )
  }

  return NextResponse.json({ ok: true, key, token: data.token, bucket: SUPPORT_BUCKET })
}

export async function GET(req: NextRequest) {
  const key = new URL(req.url).searchParams.get('key')
  if (!key) return NextResponse.json({ ok: false, message: 'key required' }, { status: 400 })

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  /*
   * Two ways to be allowed to read one: an admin, or the student whose bam id the key
   * begins with. The prefix is trustworthy because WE built it in POST above; nothing a
   * client sends ever becomes part of a key.
   */
  const admin = await requireAdmin()
  if (!admin.ok) {
    const bamId = await callerBamId(db)
    if (!bamId || !keyBelongsToBam(key, bamId)) {
      // Same answer for "not yours" and "does not exist", so this cannot be used to find
      // out whether a given key is real.
      return NextResponse.json({ ok: false, message: 'Not found' }, { status: 404 })
    }
  }

  // The row is what says the file is a support attachment at all, and it carries the type
  // and the name to serve it with. An object with no message is not servable.
  const { data: rows, error: rowErr } = await db.from('portal_question_messages')
    .select('attachment_mime, attachment_name').eq('attachment_key', key).limit(1)
  if (rowErr) {
    console.error('[support/attachment] message lookup failed:', rowErr.message)
    return NextResponse.json({ ok: false, message: 'Please try again.' }, { status: 503 })
  }
  const row = (rows ?? [])[0] as { attachment_mime: string | null; attachment_name: string | null } | undefined
  if (!row) return NextResponse.json({ ok: false, message: 'Not found' }, { status: 404 })

  const { data: file, error } = await db.storage.from(SUPPORT_BUCKET).download(key)
  if (error || !file) {
    return NextResponse.json({ ok: false, message: 'Not found' }, { status: 404 })
  }

  const mime = row.attachment_mime ?? file.type ?? 'application/octet-stream'
  return new NextResponse(Buffer.from(await file.arrayBuffer()), {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `inline; filename="${safeDownloadName(row.attachment_name, mime)}"`,
      // Private: this is somebody's support thread, and a shared cache must not hold it.
      'Cache-Control': 'private, max-age=300',
      // The bytes came from outside. Never let a browser sniff its way to executing them.
      'X-Content-Type-Options': 'nosniff'
    }
  })
}
