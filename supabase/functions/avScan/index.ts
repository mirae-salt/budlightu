/**
 * Edge Function: avScan
 * Triggered by Supabase Storage upload webhook on the `receipts` bucket.
 *
 * Scans the uploaded file for malware. On clean: marks receipt.status
 * pending (normal processing). On infected: quarantines the file (moves
 * to `quarantine` bucket), sets receipt.status='rejected' with a
 * decision_reason, alerts admin.
 *
 * Uses Cloudmersive Virus Scan API (or similar). Provider is configurable
 * via env — swap for ClamAV in a container or ScanAPI, whatever Salt IT
 * approves. Sig checks happen server-side; NO scan = HARD BLOCK.
 */
import { serviceClient } from '../_shared/supabase-admin'

export async function handler(req: {
  bucket: string
  key: string
  bam_id: string
  size: number
  mime: string
}) {
  const db = serviceClient()

  // MIME + size guard (belt-and-braces on top of client-side check)
  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  if (!ALLOWED_MIME.includes(req.mime)) {
    await reject(db, req, `disallowed mime: ${req.mime}`)
    return { ok: false, quarantined: true, reason: 'mime' }
  }
  if (req.size > 10 * 1024 * 1024) {
    await reject(db, req, `size ${req.size} > 10MB`)
    return { ok: false, quarantined: true, reason: 'size' }
  }

  const apiKey = process.env.CLOUDMERSIVE_API_KEY
  if (!apiKey) {
    // dev / no scan configured: LOG-ONLY (never silent-approve infected files in prod)
    if (process.env.NODE_ENV === 'production') {
      await reject(db, req, 'AV scanner not configured — HARD BLOCK in production')
      return { ok: false, quarantined: true, reason: 'no_scanner' }
    }
    return { ok: true, scanned: false, reason: 'dev: AV skipped' }
  }

  // Download bytes
  const { data: file, error: dlErr } = await db.storage.from(req.bucket).download(req.key)
  if (dlErr || !file) return { ok: false, error: `download failed: ${dlErr?.message}` }
  const bytes = new Uint8Array(await file.arrayBuffer())

  // Scan
  const scanResp = await fetch('https://api.cloudmersive.com/virus/scan/file', {
    method: 'POST',
    headers: { Apikey: apiKey, 'Content-Type': 'application/octet-stream' },
    body: bytes
  })
  if (!scanResp.ok) {
    return { ok: false, error: `scan API error: ${scanResp.status}` }
  }
  const result = await scanResp.json() as { CleanResult: boolean; FoundViruses?: Array<{ VirusName: string }> }

  if (!result.CleanResult) {
    const viruses = result.FoundViruses?.map(v => v.VirusName).join(', ') ?? 'unknown'
    await quarantine(db, req, `AV detected: ${viruses}`)
    return { ok: false, quarantined: true, reason: viruses }
  }

  return { ok: true, scanned: true, clean: true }
}

async function reject(db: any, req: { bucket: string; key: string; bam_id: string }, reason: string) {
  await db.from('receipts').update({
    status: 'rejected', decision_reason: reason, decided_by: null, decided_at: new Date().toISOString()
  }).eq('storage_key', req.key)
  await db.from('audit_log').insert({
    actor_role: 'system', entity: 'receipts', entity_id: null, action: 'av_reject',
    after_json: { key: req.key, reason }
  })
}

async function quarantine(db: any, req: { bucket: string; key: string }, reason: string) {
  // Move file to quarantine bucket (create bucket in Supabase console)
  const { data: file } = await db.storage.from(req.bucket).download(req.key)
  if (file) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await db.storage.from('quarantine').upload(req.key, bytes, { upsert: true })
  }
  await db.storage.from(req.bucket).remove([req.key])
  await reject(db, req as any, reason)
}
