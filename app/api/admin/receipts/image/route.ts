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

export async function GET(req: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const url = new URL(req.url)
  const key = url.searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })

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

  return new NextResponse(buf, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=300',
    },
  })
}
