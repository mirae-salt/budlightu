/**
 * POST /api/onboarding/complete  { form }
 * Session-based onboarding — the BAM is already authenticated (magic link).
 * Validates banking info, updates the bams row, encrypts banking fields.
 * No invite token needed; auth session IS the access control.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { validateInstitution, validateTransit, validateAccount, isValidHst } from '../../../../lib/validation'
import { lookupBank } from '../../../../lib/banks'

export async function POST(req: NextRequest) {
  // Get the authenticated user from session
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {}
      }
    }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ ok: false, message: 'Not signed in' }, { status: 401 })
  }

  const { form } = await req.json()
  if (!form) {
    return NextResponse.json({ ok: false, message: 'form data required' }, { status: 400 })
  }

  const db = serviceClient()

  // Find the BAM record linked to this auth user
  const { data: bam, error: bamErr } = await db
    .from('bams')
    .select('id, status')
    .eq('auth_user_id', user.id)
    .single()

  if (bamErr || !bam) {
    return NextResponse.json({ ok: false, message: 'No BAM record found for your account.' }, { status: 404 })
  }

  // This route writes banking details, so it must only ever complete a FIRST
  // onboarding. `status` was selected and never checked, which meant an already
  // active BAM could POST here and rewrite their own payout destination — the
  // exact thing /portal/account tells students is impossible ("if someone ever
  // got into your account, they could point your pay at themselves"), and a
  // violation of CLAUDE.md constraint 5. Corrections go through
  // /portal/account -> /api/portal/banking-request, where an admin applies them
  // and the change is audited.
  if (bam.status !== 'pending') {
    return NextResponse.json({
      ok: false,
      message: 'Your account is already set up. To correct your banking details, use Banking details in the portal so your program manager can apply the change.'
    }, { status: 409 })
  }

  // Validate banking info
  try {
    validateInstitution(form.institution_no)
    validateTransit(form.transit_no)
    validateAccount(form.account_no)
    if (form.hst_number && !isValidHst(form.hst_number)) {
      throw new Error('invalid HST number format')
    }
  } catch (e) {
    return NextResponse.json({ ok: false, message: `Banking info validation failed: ${(e as Error).message}` }, { status: 400 })
  }

  const bank = lookupBank(form.bank_name)
  if (!bank) {
    return NextResponse.json({ ok: false, message: `Bank "${form.bank_name}" not in our lookup. Please contact your program manager.` }, { status: 400 })
  }

  // Update BAM record
  const { error: updErr } = await db.from('bams').update({
    first_name:    form.first_name,
    last_name:     form.last_name,
    phone:         form.phone,
    street:        form.street,
    city:          form.city,
    prov:          form.prov,
    postal:        form.postal,
    school_id:     form.school_id,
    bank_name:     bank.displayName,
    consent_ap_cc: form.consent_ap_cc,
    // T&C acceptance was collected by the form and thrown away. Stamped
    // server-side, never taken from the client, and versioned (see 0020).
    consent_terms_at: form.consent_terms ? new Date().toISOString() : null,
    consent_terms_version: form.consent_terms ? '2026-09-01' : null,
    status:        'active',
    email_verified_at: new Date().toISOString()
  }).eq('id', bam.id)

  if (updErr) {
    return NextResponse.json({ ok: false, message: `Update failed: ${updErr.message}` }, { status: 500 })
  }

  // Encrypt banking fields
  const { error: encErr } = await db.rpc('encrypt_bam_banking', {
    p_bam_id: bam.id,
    p_institution_no: form.institution_no,
    p_transit_no:     form.transit_no,
    p_account_no:     form.account_no,
    p_hst_number:     form.hst_number ?? null
  })

  if (encErr) {
    return NextResponse.json({ ok: false, message: `Encrypt failed: ${encErr.message}` }, { status: 500 })
  }

  return NextResponse.json({ ok: true, message: 'Onboarding complete.' })
}
