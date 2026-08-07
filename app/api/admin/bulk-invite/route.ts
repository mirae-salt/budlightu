/**
 * POST /api/admin/bulk-invite
 * Accepts an array of BAM rows from CSV import, creates bams records,
 * resolves initials, generates invite tokens, and sends onboarding emails.
 *
 * Body: { cohort_id: string, bams: Array<{ first_name, last_name, email, school? }> }
 * Returns: { ok, created, errors[], email_results[] }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { randomBytes, createHash } from 'crypto'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { sendEmail } from '../../../../lib/send-email'
import { resolveInitials, type Bam } from '../../../../lib/initials'
import { appBaseUrl } from '../../../../lib/app-url'

const MAX_BATCH = 100

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { cohort_id, bams: rawBams } = body as {
    cohort_id: string
    bams: Array<{ first_name: string; last_name: string; email: string; school?: string }>
  }

  if (!cohort_id || !rawBams || !Array.isArray(rawBams) || rawBams.length === 0) {
    return NextResponse.json({ ok: false, message: 'cohort_id and bams[] required' }, { status: 400 })
  }
  if (rawBams.length > MAX_BATCH) {
    return NextResponse.json({ ok: false, message: `Max ${MAX_BATCH} BAMs per batch` }, { status: 400 })
  }

  // --- auth check ---
  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supa = createServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} }
  })
  const { data: user } = await supa.auth.getUser()
  const isDev = process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH_BYPASS === 'true'
  if (!isDev) {
    if (!user.user) return NextResponse.json({ ok: false }, { status: 401 })
    const role = (user.user.user_metadata as { role?: string }).role
    if (!role || !['program_admin', 'super_admin'].includes(role)) {
      return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 })
    }
  }

  const admin = serviceClient()

  // --- validate cohort exists ---
  const { data: cohort, error: cohortErr } = await admin
    .from('cohorts').select('id, name').eq('id', cohort_id).single()
  if (cohortErr || !cohort) {
    return NextResponse.json({ ok: false, message: 'Cohort not found' }, { status: 404 })
  }

  // --- validate & dedupe input ---
  const errors: string[] = []
  const cleaned: Array<{ first_name: string; last_name: string; email: string; school: string | null }> = []
  const seenEmails = new Set<string>()

  for (let i = 0; i < rawBams.length; i++) {
    const b = rawBams[i]
    const row = i + 1
    if (!b.first_name?.trim()) { errors.push(`Row ${row}: missing first name`); continue }
    if (!b.email?.trim()) { errors.push(`Row ${row}: missing email`); continue }
    const email = b.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push(`Row ${row}: invalid email "${email}"`); continue }
    if (seenEmails.has(email)) { errors.push(`Row ${row}: duplicate email "${email}" in file`); continue }
    seenEmails.add(email)
    cleaned.push({
      first_name: b.first_name.trim(),
      last_name: (b.last_name ?? '').trim(),
      email,
      school: b.school?.trim() || null
    })
  }

  if (errors.length > 0 && cleaned.length === 0) {
    return NextResponse.json({ ok: false, errors, message: 'All rows had errors' }, { status: 400 })
  }

  // --- check for existing emails in DB ---
  const { data: existing } = await admin
    .from('bams')
    .select('email')
    .in('email', cleaned.map(b => b.email))
  const existingEmails = new Set((existing ?? []).map((e: { email: string }) => e.email.toLowerCase()))
  const toInsert = cleaned.filter(b => {
    if (existingEmails.has(b.email)) {
      errors.push(`Skipped: ${b.email} already exists in roster`)
      return false
    }
    return true
  })

  if (toInsert.length === 0) {
    return NextResponse.json({
      ok: true,
      created: 0,
      skipped: cleaned.length,
      errors: errors.length > 0 ? errors : undefined,
      message: 'All emails already exist in roster — 0 new BAMs imported'
    })
  }

  // --- resolve initials (need existing BAMs in same cohort) ---
  const { data: existingBams } = await admin
    .from('bams')
    .select('id, first_name, last_name, initials_resolved')
    .eq('cohort_id', cohort_id)
  const existingBamList: Bam[] = (existingBams ?? []).map((b: { id: string; first_name: string; last_name: string }) => ({
    id: b.id, firstName: b.first_name, lastName: b.last_name
  }))
  const newBamList: Bam[] = toInsert.map((b, i) => ({
    id: `new-${i}`, firstName: b.first_name, lastName: b.last_name
  }))
  const allBams = [...existingBamList, ...newBamList]

  let initialsMap: Map<string, string>
  try {
    const resolved = resolveInitials(allBams)
    initialsMap = new Map(resolved.map(r => [r.bamId, r.initials]))
  } catch (e: unknown) {
    return NextResponse.json({
      ok: false,
      message: e instanceof Error ? e.message : 'Initials collision unresolvable',
      errors
    }, { status: 409 })
  }

  // --- insert BAMs ---
  const insertRows = toInsert.map((b, i) => ({
    cohort_id,
    first_name: b.first_name,
    last_name: b.last_name,
    email: b.email,
    school_id: b.school,
    status: 'pending' as const,
    initials_resolved: initialsMap.get(`new-${i}`) ?? null
  }))

  const { data: inserted, error: insertErr } = await admin
    .from('bams')
    .insert(insertRows)
    .select('id, email, first_name, last_name')

  if (insertErr || !inserted) {
    return NextResponse.json({ ok: false, message: insertErr?.message ?? 'Insert failed', errors }, { status: 500 })
  }

  // --- generate invite tokens + send emails ---
  const appUrl = appBaseUrl()
  const emailResults: Array<{ email: string; sent: boolean; error?: string }> = []

  for (const bam of inserted as { id: string; email: string; first_name: string }[]) {
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')

    await admin.from('bams').update({ invite_token_hash: tokenHash }).eq('id', bam.id)

    const inviteUrl = `${appUrl}/portal/onboarding/${rawToken}`
    const result = await sendEmail({
      to: bam.email,
      subject: `You're invited to Bud Light U — set up your account`,
      html: inviteEmailHtml(bam.first_name, inviteUrl)
    })
    emailResults.push({ email: bam.email, sent: result.sent, error: result.error })
  }

  const actorId = user.user?.id ?? 'dev'
  await admin.from('audit_log').insert({
    actor_id: actorId, actor_role: 'admin', entity: 'bams',
    entity_id: cohort_id, action: 'bulk_invite',
    meta: { count: inserted.length, skipped: cleaned.length - toInsert.length, sent: emailResults.filter(r => r.sent).length }
  })

  return NextResponse.json({
    ok: true,
    created: inserted.length,
    skipped: cleaned.length - toInsert.length,
    errors: errors.length > 0 ? errors : undefined,
    email_results: emailResults
  })
}

function inviteEmailHtml(firstName: string, inviteUrl: string): string {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <h2 style="color: #001a3e; margin: 0;">Bud Light U</h2>
      <p style="color: #6b7280; font-size: 13px; margin: 4px 0 0;">Campus Ambassador Program</p>
    </div>
    <p style="font-size: 16px; color: #1a1a1a;">Hi ${firstName},</p>
    <p style="font-size: 15px; color: #333; line-height: 1.6;">
      You've been selected as a Bud Light U Brand Ambassador! To get started,
      set up your account by clicking the link below. You'll enter your personal
      and banking details so we can process your monthly payments.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${inviteUrl}"
         style="background: #0073cf; color: #ffffff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
        Set up my account
      </a>
    </div>
    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      This link is one-time use and tied to your email. If you have any questions,
      reply to this email or contact your program manager.
    </p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;" />
    <p style="font-size: 11px; color: #9ca3af; text-align: center;">
      Bud Light U · Campus Ambassador Program · Powered by Salt XC
    </p>
  </div>`
}
