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
import { validateAttestations, ATTESTATION_VERSION } from '../../../../lib/attestations'
import { lookupBank, OTHER_BANK, otherBankNameProblem } from '../../../../lib/banks'
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
    .select('id, status, cohort_id')
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
  const attest = validateAttestations({
    workAuth: form.work_auth,
    bankingOwner: form.banking_owner,
    aiTraining: form.ai_training
  })
  if (!attest.ok) {
    return NextResponse.json({ ok: false, message: attest.error }, { status: 400 })
  }

  const hst = validateHstDeclaration({
    status: form.hst_status,
    number: form.hst_number,
    attested: form.hst_attested
  })
  if (!hst.ok) {
    return NextResponse.json({ ok: false, message: hst.message }, { status: 400 })
  }

  /*
   * "Other" is a real answer, not a failed lookup.
   *
   * The dropdown has offered it for a while and the server refused it, so a student
   * whose credit union is not on our list was told to contact their program manager and
   * could go no further. Janet reported two of them by name on 2026-09-04.
   *
   * With no table entry there is no institution number to compare against, so the
   * cross-check is skipped rather than faked. The form says as much on screen. Every
   * other guard is unchanged: the number is still format-checked, still stored as text
   * so a leading zero survives, and still encrypted.
   */
  let bank: { displayName: string; institutionNo: string } | null = null
  let bankIsUnlisted = false

  if (form.bank_name === OTHER_BANK) {
    const problem = otherBankNameProblem(form.bank_name_other)
    if (problem) return NextResponse.json({ ok: false, message: problem }, { status: 400 })
    bank = { displayName: String(form.bank_name_other).trim(), institutionNo: '' }
    bankIsUnlisted = true
  } else {
    bank = lookupBank(form.bank_name)
    if (!bank) {
      return NextResponse.json({ ok: false, message: `Bank "${form.bank_name}" not in our lookup. Choose "Other" and type the name.` }, { status: 400 })
    }
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
  const nowIso = new Date().toISOString()
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
    hst_declared_at: nowIso,
    hst_declaration_version: hst.version,
    // Work authorisation and banking ownership (Shane Deen, 2026-08-27). Stamped
    // server-side from the validated result, like every other consent on this row.
    work_auth_attested_at: nowIso,
    work_auth_version: ATTESTATION_VERSION,
    banking_attested_at: nowIso,
    banking_version: ATTESTATION_VERSION,
    // Optional and refusable, so a "no" is stored as false rather than left looking
    // like a question nobody asked.
    consent_ai_training: attest.aiTraining,
    consent_ai_training_at: attest.aiTraining === null ? null : nowIso,
    consent_ai_training_version: attest.aiTraining === null ? null : ATTESTATION_VERSION
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
  /*
   * The number that gets stored is the student's own. For a bank on our list a
   * disagreement with the table stops the write and asks them once; for an unlisted
   * bank there is nothing to disagree with, so there is nothing to ask.
   */
  let institutionToStore = form.institution_no
  if (!bankIsUnlisted) {
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
    institutionToStore = decision.institutionNo
  }

  // Encrypt banking fields
  const { error: encErr } = await db.rpc('encrypt_bam_banking', {
    p_bam_id: bam.id,
    p_institution_no: institutionToStore,
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

  /*
   * Give them this month's draft invoice straight away.
   *
   * The monthly job opens every active BAM's invoice on the 1st, which leaves anyone
   * onboarding mid-month with nothing to edit until the next one. Janet's ask was to be
   * able to put a bar tab on a student's invoice before they submit anything, and a
   * student who joins on the 12th is exactly who that is for.
   *
   * A failure here is logged, not returned. Their onboarding IS complete: banking is
   * stored and the row is active. Turning a successful signup into an error screen over
   * a draft invoice, which the 1st-of-month job will create anyway, would be the wrong
   * trade.
   */
  try {
    const { seedPeriodInvoice, periodOf } = await import('../../../../lib/seed-period-invoice')
    const seeded = await seedPeriodInvoice(db, {
      bamId: bam.id,
      cohortId: bam.cohort_id,
      period: periodOf(new Date())
    })
    if (!seeded.ok) console.warn('[onboarding/complete] no draft invoice for', bam.id, '-', seeded.reason)
  } catch (e) {
    console.warn('[onboarding/complete] seeding the draft invoice failed for', bam.id, '-', e)
  }

  return NextResponse.json({ ok: true, message: 'Onboarding complete.' })
}
