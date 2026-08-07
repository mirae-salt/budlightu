import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validatePeriod } from '../../../../lib/period'
import { triggerOcr } from '../../../../lib/ocr-trigger'
import { requireAdmin, requireBam, denied } from '../../../../lib/admin-auth'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const TEST_RECEIPT_SHA = '52076429a897991a9afc42187ca2a04c3beed099955d0675cb180352d09a268d'
const MAX_BYTES = 10 * 1024 * 1024
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

  if (!file || !bamId || !sha256 || !periodRaw) {
    return NextResponse.json({ ok: false, message: 'Missing required fields' }, { status: 400 })
  }

  // Server-side file validation
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ ok: false, message: 'Unsupported file type. Only JPG, PNG, WebP, and PDF are accepted.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, message: `File too large. Maximum size is ${MAX_BYTES / 1024 / 1024} MB.` }, { status: 400 })
  }

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
  const periodCheck = validatePeriod(periodRaw, cohortRow)
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
    sha256: effectiveSha
  }).select('id').single()

  if (insErr) {
    return NextResponse.json({ ok: false, message: insErr.message }, { status: 500 })
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
