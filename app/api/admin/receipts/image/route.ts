/**
 * GET /api/admin/receipts/image?key=...
 *
 * P0-A: no authorization check existed, and the handler downloads any key from
 * the private `receipts` bucket with the service-role key. Storage RLS was
 * therefore bypassed for anonymous callers. Admin-only now; BAMs read their own
 * receipts through the portal, which goes through RLS.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin, denied } from '@/lib/admin-auth'
import { receiptDownloadFilename } from '@/lib/receipt-filename'

export async function GET(req: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const url = new URL(req.url)
  const key = url.searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
  // Optional label only. The review queue already has the BAM's name on the row, so
  // passing it here avoids a lookup per thumbnail; the MONTH comes from the key, which
  // is the file that was actually downloaded, so the two cannot disagree. Sanitized in
  // receiptDownloadFilename before it reaches the header.
  const name = url.searchParams.get('name')

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data, error } = await admin.storage.from('receipts').download(key)
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'not found' }, { status: 404 })
  }

  const buf = Buffer.from(await data.arrayBuffer())
  const mime = data.type || 'image/jpeg'

  /*
   * `inline` keeps the thumbnail and the lightbox rendering in place; the filename is
   * what a browser uses for "Save image as...". Without it the suggested name came from
   * the route ("image"), so every saved receipt landed with the same useless name and no
   * month on it.
   */
  return new NextResponse(buf, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `inline; filename="${receiptDownloadFilename(key, name)}"`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}
