/**
 * POST /api/portal/support  { question }
 * Inserts a support question and emails Robin.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../lib/send-email'

const ROBIN_EMAIL = 'robin.graham@ilovesalt.com'

export async function POST(req: NextRequest) {
  const isDev = process.env.NODE_ENV === 'development'
  const body = await req.json()
  const { question } = body

  if (!question || question.trim().length < 5) {
    return NextResponse.json({ ok: false, message: 'Question is too short' }, { status: 400 })
  }

  let userId: string | null = null
  let userEmail = ''

  if (!isDev) {
    const cookieStore = await cookies()
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const supa = createServerClient(url, anon, {
      cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
    })
    const { data: { user } } = await supa.auth.getUser()
    if (!user) return NextResponse.json({ ok: false, message: 'Not authenticated' }, { status: 401 })
    userId = user.id
    userEmail = user.email ?? ''
  } else {
    userEmail = 'demo.bam@school.edu'
  }

  const admin = serviceClient()

  // Look up BAM details
  let bamName = 'Unknown BAM'
  let bamId: string | null = null
  if (userId) {
    const { data: bam } = await admin.from('bams')
      .select('id, first_name, last_name')
      .eq('auth_user_id', userId)
      .single()
    if (bam) {
      bamId = bam.id
      bamName = `${bam.first_name} ${bam.last_name}`
    }
  }

  // Insert question into DB
  const { error: insErr } = await admin.from('portal_questions').insert({
    bam_id: bamId,
    question: question.trim(),
  })

  if (insErr) {
    return NextResponse.json({ ok: false, message: insErr.message }, { status: 500 })
  }

  // Email Robin
  await sendEmail({
    to: ROBIN_EMAIL,
    subject: `BLU support question from ${bamName}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <p style="font-size: 16px; color: #1a1a2e; font-weight: 600;">New BAM question</p>
        <table style="font-size: 14px; color: #374151; line-height: 1.8; border-collapse: collapse;">
          <tr><td style="padding-right: 16px; font-weight: 600;">From</td><td>${bamName}</td></tr>
          <tr><td style="padding-right: 16px; font-weight: 600;">Email</td><td>${userEmail}</td></tr>
        </table>
        <div style="margin-top: 16px; padding: 16px; background: #f3f4f6; border-radius: 8px; font-size: 14px; color: #1a1a2e; white-space: pre-wrap;">${question.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}</div>
        <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">Reply directly to the BAM at <a href="mailto:${userEmail}">${userEmail}</a>.</p>
        <p style="font-size: 12px; color: #9ca3af; margin-top: 16px;">— BLU Portal</p>
      </div>
    `,
    text: `New BAM question\n\nFrom: ${bamName} (${userEmail})\n\n${question.trim()}\n\nReply to: ${userEmail}\n\n— BLU Portal`
  }).catch(() => {})

  return NextResponse.json({ ok: true })
}
