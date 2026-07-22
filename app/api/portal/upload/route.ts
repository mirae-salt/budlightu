import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

export async function POST(req: Request) {
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

  // Dev mode: nil UUID means no auth session — pick first real BAM from DB
  if (bamId === NIL_UUID) {
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
  }

  const ext = file.name.split('.').pop() || 'bin'
  const storageKey = `${bamId}/${period}/${sha256}.${ext}`

  const buf = Buffer.from(await file.arrayBuffer())
  const { error: upErr } = await admin.storage
    .from('receipts')
    .upload(storageKey, buf, { contentType: file.type, upsert: false })

  if (upErr && !/duplicate/i.test(upErr.message)) {
    return NextResponse.json({ ok: false, message: upErr.message }, { status: 500 })
  }

  const { error: insErr } = await admin.from('receipts').insert({
    bam_id: bamId,
    cohort_id: cohortId,
    period,
    storage_key: storageKey,
    storage_mime: file.type,
    storage_bytes: file.size,
    sha256
  })

  if (insErr) {
    return NextResponse.json({ ok: false, message: insErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, storageKey })
}
