import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

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
  const period = form.get('period') as string | null
  let cohortId = form.get('cohort_id') as string | null

  if (!file || !bamId || !sha256 || !period) {
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
    // Production: verify the session user owns this bam_id
    const cookieStore = await cookies()
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const supa = createServerClient(url, anon, {
      cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
    })
    const { data: { user } } = await supa.auth.getUser()
    if (!user) {
      return NextResponse.json({ ok: false, message: 'Not authenticated' }, { status: 401 })
    }
    const userRole = (user.user_metadata as { role?: string }).role
    if (userRole === 'program_admin' || userRole === 'super_admin') {
      return NextResponse.json({ ok: false, message: 'Admin accounts cannot upload receipts' }, { status: 403 })
    }
    // Look up the BAM linked to this auth user
    const { data: sessionBam } = await admin.from('bams')
      .select('id, cohort_id')
      .eq('auth_user_id', user.id)
      .single()
    if (!sessionBam) {
      return NextResponse.json({ ok: false, message: 'No BAM account found for this user' }, { status: 403 })
    }
    if (sessionBam.id !== bamId) {
      return NextResponse.json({ ok: false, message: 'You can only upload receipts for your own account' }, { status: 403 })
    }
    cohortId = cohortId || sessionBam.cohort_id
  }

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

  // Check for duplicate receipt (same file already uploaded by this BAM)
  if (!isTestReceipt) {
    const { data: dup } = await admin.from('receipts')
      .select('id, period').eq('bam_id', bamId).eq('sha256', sha256).single()
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

  // Fire-and-forget OCR — don't block the upload response
  const baseUrl = req.nextUrl.origin
  const ocrHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  if (process.env.INTERNAL_API_SECRET) {
    ocrHeaders['x-internal-secret'] = process.env.INTERNAL_API_SECRET
  }
  fetch(`${baseUrl}/api/receipts/ocr`, {
    method: 'POST',
    headers: ocrHeaders,
    body: JSON.stringify({ receipt_id: inserted.id, storage_key: storageKey })
  }).catch(e => console.error('[upload] OCR trigger failed:', e))

  return NextResponse.json({ ok: true, storageKey, receipt_id: inserted.id })
}
