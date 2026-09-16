import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validatePeriod } from '../../../../lib/period'
import { triggerOcr } from '../../../../lib/ocr-trigger'
import { requireAdmin, requireBam, denied } from '../../../../lib/admin-auth'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const TEST_RECEIPT_SHA = '52076429a897991a9afc42187ca2a04c3beed099955d0675cb180352d09a268d'
/*
 * 4,300,000 bytes, and the odd number is the point.
 *
 * This said 10 MB, and so did the upload page, and neither was true. Vercel refuses a
 * serverless function request body over 4.5 MB itself: the reply is a plain-text
 * FUNCTION_PAYLOAD_TOO_LARGE, not our JSON, so the portal had nothing to show and printed
 * "Upload failed:" with no reason. Theo Cliche lost a day to it on 2026-09-04 and only got
 * through from his phone, where the browser sends a smaller photo. A student who does not
 * write in just does not get reimbursed.
 *
 * Measured against production on 2026-09-08, not looked up: 4,400,000 bytes reached this
 * route (401, no session) and 4,600,000 was refused by the platform with a 413.
 *
 * It has to sit above every receipt that already works and below what the platform takes.
 * The largest real one is 4,330,000 bytes, and 4,400,000 is the largest size measured
 * getting through, so the window is narrow and this is the top of it, ~100 KB under the
 * ceiling for multipart overhead.
 *
 * It was briefly 4,300,000, which was BELOW that largest real receipt and would have
 * started refusing an upload that had already worked. The mistake was comparing a size
 * read in MiB (4.13) against a limit written in decimal MB, which are different numbers
 * for the same file. Sizes here are decimal bytes throughout, and the constant is a
 * measurement rather than a round number, because a round number nobody had measured is
 * what caused all of this.
 *
 * Raising it needs the upload to stop going through the function at all (a signed upload
 * straight to Supabase Storage), not a bigger number here.
 * `experimental.serverActions.bodySizeLimit` in next.config.js does NOT apply: this is a
 * route handler, not a server action.
 */
const MAX_BYTES = 4_400_000
/** What to call it on screen. Kept beside the number so the two cannot drift. */
const MAX_LABEL = '4.4 MB'
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

export async function POST(req: NextRequest) {
  const isDev = process.env.NODE_ENV === 'development'
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const form = await req.formData()
  const file = form.get('file') as File | null
  let bamId = form.get('bam_id') as string | null
  const sha256 = form.get('sha256') as string | null
  const periodRaw = form.get('period') as string | null
  let cohortId = form.get('cohort_id') as string | null
  // Admin-only, and only honored below once requireAdmin() has actually passed --
  // reading it here is just reading a string off the request.
  const overrideReasonRaw = form.get('override_reason') as string | null
  /*
   * The BAM's own claim that this is a special or limited release bought outside the
   * normal window. Unlike `override_reason` this needs no privilege: it can only ever
   * make a receipt stricter (lib/classify-receipt sends it to a person and it can never
   * auto-pass), so a student setting it on an ordinary receipt costs them a wait, not
   * money they were not owed.
   */
  const lateSubmission = String(form.get('late_submission') ?? '') === 'true'

  if (!file || !bamId || !sha256 || !periodRaw) {
    return NextResponse.json({ ok: false, message: 'Missing required fields' }, { status: 400 })
  }

  // Server-side file validation
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ ok: false, message: 'Unsupported file type. Only JPG, PNG, WebP, and PDF are accepted.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({
      ok: false,
      message: `That file is over ${MAX_LABEL}. Take the photo on your phone and upload it there, which usually makes a smaller file.`
    }, { status: 400 })
  }
  /*
   * There was an upper bound and no lower one, so an empty file was accepted, stored, and
   * only failed much later when the model was handed a data URL with no image in it. What
   * Jackson Bennett got on 2026-09-05 was a receipt stuck on "OCR endpoint returned 500 /
   * OpenRouter 400: Invalid image data-url", which blames the wrong thing and tells him
   * nothing he can act on. It was his only submission for the month.
   *
   * A kilobyte is far under any real photo: the smallest genuine upload on file is 165 KB.
   * Anything below it is a picker that handed back nothing, and the student needs to hear
   * that now, while they still have the receipt in their hand.
   */
  if (file.size < 1024) {
    return NextResponse.json({
      ok: false,
      message: 'That file came through empty. Please pick the photo again, or take a new one.'
    }, { status: 400 })
  }

  // Set only inside the admin-on-behalf branch below, and only once a non-empty
  // reason was given. Threaded into validatePeriod, and the audit_log row is
  // written right after a successful insert, below.
  let allowClosedOverride = false
  let overrideReason: string | null = null
  let overrideActor: { userId: string; email: string | null; role: string; devBypass: boolean } | null = null

  // Verify bam_id against authenticated session (skip in dev with nil UUID)
  if (isDev && bamId === NIL_UUID) {
    const { data: firstBam } = await admin.from('bams')
      .select('id, cohort_id')
      .eq('status', 'active')
      .limit(1)
      .single()
    if (firstBam) {
      bamId = firstBam.id
      cohortId = cohortId || firstBam.cohort_id
    } else {
      return NextResponse.json({ ok: false, message: 'No active BAM found in DB for dev upload' }, { status: 400 })
    }
  } else {
    // P0-A: the admin-on-behalf branch used to key off `user_metadata.role`, which
    // the student's own session can write with the anon key. Any BAM could
    // self-promote and then upload receipts against someone else's bam_id.
    // Authorization now comes from lib/admin-auth (app_metadata only), and the
    // BAM branch resolves identity from bams.auth_user_id rather than a claim.
    const adminAuth = await requireAdmin()

    if (adminAuth.ok) {
      // Admins can upload on behalf of any BAM — just verify the bam_id exists
      const { data: targetBam, error: targetErr } = await admin.from('bams')
        .select('id, cohort_id')
        .eq('id', bamId)
        .maybeSingle()
      if (targetErr) {
        return NextResponse.json({ ok: false, message: `Could not verify that BAM: ${targetErr.message}` }, { status: 500 })
      }
      if (!targetBam) {
        return NextResponse.json({ ok: false, message: 'BAM not found' }, { status: 404 })
      }
      cohortId = cohortId || targetBam.cohort_id

      // A closed month, on purpose, because a human confirmed the receipt is real.
      // Reason is required (not just present-and-blank) so this cannot become a
      // silent default: the whole point is an audit_log row that says who and why.
      const reason = overrideReasonRaw?.trim()
      if (reason) {
        allowClosedOverride = true
        overrideActor = { userId: adminAuth.userId, email: adminAuth.email, role: adminAuth.role, devBypass: adminAuth.devBypass }
        overrideReason = reason.slice(0, 500)
      }
    } else if (adminAuth.status !== 403) {
      // 401 (no session) and 503 (server misconfigured) must NOT fall through to
      // the BAM branch: that would run an upload with no verified identity.
      return denied(adminAuth)
    } else {
      // Signed in but not an admin: the only allowed upload is their own.
      const bamAuth = await requireBam()
      if (!bamAuth.ok) return denied(bamAuth)
      if (bamAuth.bamId !== bamId) {
        return NextResponse.json({ ok: false, message: 'You can only upload receipts for your own account' }, { status: 403 })
      }
      const { data: sessionBam, error: sessionErr } = await admin.from('bams')
        .select('id, cohort_id')
        .eq('id', bamAuth.bamId)
        .maybeSingle()
      if (sessionErr || !sessionBam) {
        return NextResponse.json({ ok: false, message: 'No BAM account found for this user' }, { status: 403 })
      }
      cohortId = cohortId || sessionBam.cohort_id
    }
  }

  // P1-24: validate `period` server-side. Until this point it was whatever the
  // client posted, which meant a BAM could pick an arbitrary month and get a
  // fresh monthly cap for it (or drop a receipt into an already-invoiced month).
  if (!cohortId) {
    return NextResponse.json({ ok: false, message: 'No cohort on file for this BAM. Please contact your program manager.' }, { status: 400 })
  }
  const { data: cohortRow, error: cohortErr } = await admin.from('cohorts')
    .select('start_date, end_date')
    .eq('id', cohortId)
    .maybeSingle()
  if (cohortErr) {
    return NextResponse.json({ ok: false, message: `Could not verify your program dates: ${cohortErr.message}` }, { status: 500 })
  }
  // One lookup after bamId is settled, rather than adding is_test to each of the
  // three resolution branches above where the three copies could drift apart.
  // A test account may submit for the current month even before the program opens;
  // a real student never gets that exception (see lib/period.ts).
  const { data: bamFlags, error: flagErr } = await admin.from('bams')
    .select('is_test')
    .eq('id', bamId)
    .maybeSingle()
  if (flagErr) {
    return NextResponse.json({ ok: false, message: `Could not verify your account: ${flagErr.message}` }, { status: 500 })
  }
  const isTestBam = bamFlags?.is_test === true

  const periodCheck = validatePeriod(periodRaw, cohortRow, new Date(), { isTest: isTestBam, allowClosedOverride })
  if (!periodCheck.ok) {
    return NextResponse.json({ ok: false, message: periodCheck.message }, { status: 400 })
  }
  const period = periodCheck.period

  const isTestReceipt = isDev && sha256 === TEST_RECEIPT_SHA
  const effectiveSha = isTestReceipt ? `${sha256}-test-${Date.now()}` : sha256

  const ext = file.name.split('.').pop() || 'bin'
  const storageKey = `${bamId}/${period}/${effectiveSha}.${ext}`

  const buf = Buffer.from(await file.arrayBuffer())
  const { error: upErr } = await admin.storage
    .from('receipts')
    .upload(storageKey, buf, { contentType: file.type, upsert: true })

  if (upErr) {
    return NextResponse.json({ ok: false, message: upErr.message }, { status: 500 })
  }

  // Check for duplicate receipt (same file already uploaded by this BAM).
  // maybeSingle + explicit error check: .single() errors on 0 rows, and swallowing
  // that error is what makes a dedupe guard look like it passed.
  if (!isTestReceipt) {
    const { data: dup, error: dupErr } = await admin.from('receipts')
      .select('id, period').eq('bam_id', bamId).eq('sha256', sha256).maybeSingle()
    if (dupErr) {
      return NextResponse.json({ ok: false, message: `Could not check for duplicates: ${dupErr.message}` }, { status: 500 })
    }
    if (dup) {
      const dupMonth = new Date(dup.period).toLocaleString('en-US', { month: 'long', year: 'numeric' })
      return NextResponse.json({
        ok: false,
        message: `This receipt was already submitted for ${dupMonth}. Each receipt can only be used once.`
      }, { status: 409 })
    }
  }

  const { data: inserted, error: insErr } = await admin.from('receipts').insert({
    bam_id: bamId,
    cohort_id: cohortId,
    period,
    storage_key: storageKey,
    storage_mime: file.type,
    storage_bytes: file.size,
    sha256: effectiveSha,
    late_submission: lateSubmission
  }).select('id').single()

  if (insErr) {
    return NextResponse.json({ ok: false, message: insErr.message }, { status: 500 })
  }

  // The whole point of allowClosedOverride is that this row exists. If the trail
  // cannot be written, refuse rather than leave an override with no record of who
  // authorized it or why -- the receipt and file are already stored, so this is a
  // "contact Mirae" state, not a silent success.
  if (overrideActor) {
    const { error: auditErr } = await admin.from('audit_log').insert({
      actor_id: overrideActor.devBypass ? null : overrideActor.userId,
      actor_role: overrideActor.role,
      entity: 'receipts',
      entity_id: inserted.id,
      action: 'period_override',
      before_json: { bam_id: bamId, period },
      after_json: { reason: overrideReason, overridden_by: overrideActor.email ?? overrideActor.userId }
    })
    if (auditErr) {
      return NextResponse.json({
        ok: false,
        message: `Receipt was saved (id ${inserted.id}) but the audit log entry for this override failed: ${auditErr.message}. Contact Mirae before relying on this receipt.`
      }, { status: 500 })
    }
  }

  // P1-13: reliable OCR trigger. The old bare fetch() was neither awaited nor kept
  // alive, so on Vercel the receipt could stay at status='pending' forever, invisible
  // in the admin review queue. triggerOcr stamps ocr_queued_at first, schedules the
  // call with after(), and flips the receipt to 'ocr_failed' (which IS visible) if the
  // call never lands. sweep_stale_ocr_receipts() is the final backstop.
  const trigger = await triggerOcr(admin, {
    receiptId: inserted.id,
    storageKey,
    baseUrl: req.nextUrl.origin
  })

  return NextResponse.json({
    ok: true,
    storageKey,
    receipt_id: inserted.id,
    ocr_queued: trigger.queued,
    ...(trigger.error ? { ocr_error: trigger.error } : {})
  })
}
