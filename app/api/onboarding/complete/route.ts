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
import { validateInstitution, validateTransit, validateAccount } from '../../../../lib/validation'
import { validateHstDeclaration } from '../../../../lib/hst-declaration'
import { lookupBank } from '../../../../lib/banks'
import { TERMS_VERSION } from '../../../../lib/terms'
import { decideInstitution } from '../../../../lib/institution-confirm'

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
  } catch (e) {
    return NextResponse.json({ ok: false, message: `Banking info validation failed: ${(e as Error).message}` }, { status: 400 })
  }

  // The GST/HST declaration. Same rules as the other onboarding path, from the same
  // function, because two onboarding entry points disagreeing about what counts as a
  // valid declaration is how one of them ends up storing a number nobody attested to.
  const hst = validateHstDeclaration({
    status: form.hst_status,
    number: form.hst_number,
    attested: form.hst_attested
  })
  if (!hst.ok) {
    return NextResponse.json({ ok: false, message: hst.message }, { status: 400 })
  }

  const bank = lookupBank(form.bank_name)
  if (!bank) {
    return NextResponse.json({ ok: false, message: `Bank "${form.bank_name}" not in our lookup. Please contact your program manager.` }, { status: 400 })
  }

  // ORDER MATTERS. This used to write status:'active' first and encrypt banking
  // second. When the encrypt failed the row was left 'active' with NULL banking, and
  // the guard at the top of this route ("already set up", 409) then refused every
  // retry — so the student could not get back to the form, and their invoice was hard
  // blocked on missing banking forever. The sibling Edge Function (onboarding-ingest)
  // rolls back in the same situation; this route did not.
  //
  // Now: profile fields first, then banking, and status flips to 'active' only after
  // the banking write is confirmed. A failure anywhere leaves the row 'pending', which
  // is exactly the state that lets them try again.
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
    consent_terms_version: form.consent_terms ? TERMS_VERSION : null,
    // The GST/HST declaration, from the validated result so the stored status and the
    // stored number can never disagree.
    hst_status: hst.status,
    hst_declared_at: new Date().toISOString(),
    hst_declaration_version: hst.version
    // status and email_verified_at are set AFTER banking succeeds, below.
  }).eq('id', bam.id)

  if (updErr) {
    return NextResponse.json({ ok: false, message: `Update failed: ${updErr.message}` }, { status: 500 })
  }

  // WHOSE NUMBER WINS: theirs. See lib/institution-confirm.ts.
  //
  // An earlier version today stored our table's value and discarded what the student
  // typed. That routes their money by our mistake whenever the table is wrong, and hides
  // it. A disagreement now stops the write and asks them once; if they confirm, we store
  // exactly what they typed.
  const decision = decideInstitution({
    bankName: bank.displayName,
    submitted: form.institution_no,
    // Same place as onboarding-ingest expects it, so the form sends one shape to both.
    confirmed: form?.institution_confirmed === true
  })
  if (decision.kind === 'confirm') {
    console.warn(
      `[onboarding/complete] institution mismatch for "${decision.bankName}": ` +
      `submitted ${decision.submitted}, table has ${decision.ours}. Asking the student.`
    )
    // Nothing has been written yet: the profile update is below.
    return NextResponse.json(
      {
        ok: false,
        needsInstitutionConfirm: true,
        submittedInstitution: decision.submitted,
        ourInstitution: decision.ours,
        message: decision.message
      },
      { status: 409 }
    )
  }

  // Encrypt banking fields
  const { error: encErr } = await db.rpc('encrypt_bam_banking', {
    p_bam_id: bam.id,
    p_institution_no: decision.institutionNo,
    p_transit_no:     form.transit_no,
    p_account_no:     form.account_no,
    // From the validated declaration, never the raw field.
    p_hst_number:     hst.number
  })

  if (encErr) {
    // The row is still 'pending', so the student can submit the form again. Say that,
    // rather than leaving them with a dead end.
    console.error('[onboarding/complete] banking encrypt failed for bam', bam.id, encErr.message)
    return NextResponse.json(
      {
        ok: false,
        message: 'We saved your details but could not store your banking information securely. ' +
          'Please submit the form again. If it keeps failing, contact your program manager.'
      },
      { status: 500 }
    )
  }

  // Banking is stored. Only now is the account actually set up.
  const { data: activated, error: actErr } = await db.from('bams')
    .update({ status: 'active', email_verified_at: new Date().toISOString() })
    .eq('id', bam.id)
    .select('id, status')

  // Read-back: an update that matches zero rows reports success. If this did not
  // take, the row stays 'pending' and the student can retry — which is the safe
  // direction, but they must be told rather than shown a success screen.
  if (actErr || !activated || activated.length !== 1 || activated[0].status !== 'active') {
    console.error(
      '[onboarding/complete] banking stored but activation did not take for bam', bam.id,
      actErr?.message ?? `rows=${activated?.length ?? 0}`
    )
    return NextResponse.json(
      {
        ok: false,
        message: 'Your details were saved but we could not finish activating your account. ' +
          'Please contact your program manager before submitting again.'
      },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true, message: 'Onboarding complete.' })
}
