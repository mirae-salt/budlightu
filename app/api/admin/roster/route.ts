/**
 * PATCH /api/admin/roster  { id, ...fields }   — edit one roster row
 * POST  /api/admin/roster  { first_name, last_name, email, cohort_id, ... }
 *                                              — add one roster row
 *
 * Robin/Jenna edit roster rows here. The allowlist below is deliberately narrow:
 * every system-generated field (invoice_number, seq, payload_json,
 * email_verified_at, auth_user_id, invite_token_hash) is unreachable from this
 * route, per CLAUDE.md constraint 5. Do not widen it.
 *
 * P1-6: `email` is normalized and validated before it is written. It used to be
 * copied verbatim while the login path looked the row up with
 * `.trim().toLowerCase()`, so pasting "Lucas.Grabowski@uwo.ca" or a value with a
 * trailing space permanently locked that BAM out of login, receipt upload and
 * payment with no signal anywhere. The unique index is on lower(email), so it
 * was case-safe but not whitespace-safe. The DB trigger added in
 * 0016_auth_hardening.sql is the backstop for any future write path.
 *
 * `bank_name` is validated against lib/banks.ts here, not just at onboarding: it
 * is the input to the institution-code lookup that routes payment, and the admin
 * UI used to display it as saved while never sending it at all.
 *
 * `school_id` rejects the dash placeholder the table renders for an empty cell.
 * `mapDbBam` produces `school_id || '—'` and saveEdit sent that back verbatim, so
 * editing any BAM with no school wrote the literal glyph into the column.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import { parseEmail, cleanText } from '../../../../lib/sanitize'
import { parseBankName, parseSchoolId, parseCohortId } from '../../../../lib/admin-input'
import { lookupBank } from '../../../../lib/banks'
import { testRowCohortProblem, isTestForCohort } from '../../../../lib/admin-test-bam'
import { ensureInitialsResolved } from '../../../../lib/ensure-initials'
import { sendBamInvite } from '../../../../lib/send-invite'
import { provinceTaxRate } from '../../../../lib/invoice-payload'

const ALLOWED_FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'status',
  'school_id', 'cohort_id', 'bank_name', 'is_test',
  // The mailing address HARD BLOCKS invoice generation when any part of it is
  // blank (lib/invoice-payload.ts), and that block tells the admin to "fill it in
  // on the roster" — which was impossible: these four were not editable anywhere
  // outside onboarding, and onboarding refuses a BAM who is no longer 'pending'.
  // So a typo in a postal code could stop an invoice with no way for Robin to fix
  // it. They are editable here now.
  'street', 'city', 'prov', 'postal'
] as const

/** Values the bams.status CHECK constraint accepts. */
const VALID_STATUSES = ['pending', 'active', 'archived'] as const

/** Free-text fields that get invisible-character cleanup but keep their case. */
const TEXT_FIELDS = new Set<string>(['first_name', 'last_name', 'phone', 'street', 'city', 'postal'])

/** Columns echoed back to the client so the table only shows what was stored. */
const READBACK = 'id, first_name, last_name, email, phone, status, bank_name, school_id, cohort_id, initials_resolved, is_test, street, city, prov, postal'

/** Postgres unique_violation. Surfaced as a clear 409, not a raw driver string. */
const UNIQUE_VIOLATION = '23505'

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }

  const { id, ...fields } = (body ?? {}) as { id?: unknown } & Record<string, unknown>
  if (typeof id !== 'string' || !id) {
    return NextResponse.json({ ok: false, message: 'id required' }, { status: 400 })
  }

  const update: Record<string, unknown> = {}

  for (const k of ALLOWED_FIELDS) {
    if (!(k in fields)) continue
    const raw = fields[k]

    if (k === 'email') {
      const parsed = parseEmail(raw)
      if (!parsed.ok) {
        // Loud, not silent. A bad email here is a permanent lockout.
        return NextResponse.json({ ok: false, message: parsed.reason }, { status: 400 })
      }
      update.email = parsed.email
      continue
    }

    if (k === 'status') {
      if (typeof raw !== 'string' || !(VALID_STATUSES as readonly string[]).includes(raw)) {
        return NextResponse.json(
          { ok: false, message: `Invalid status. Use one of: ${VALID_STATUSES.join(', ')}.` },
          { status: 400 }
        )
      }
      update.status = raw
      continue
    }

    if (k === 'bank_name') {
      const bank = parseBankName(raw)
      if (!bank.ok) return NextResponse.json({ ok: false, message: bank.error }, { status: 400 })
      update.bank_name = bank.value
      continue
    }

    // Province is not free text: computeHst() THROWS on a code outside its table,
    // which turns a typo like "Ontario" or "ONT" into a failed invoice run rather
    // than a validation message. The list comes from the same table the tax
    // calculation uses, so the two cannot drift apart.
    if (k === 'prov') {
      if (raw === null || raw === undefined || (typeof raw === 'string' && !cleanText(raw))) {
        update.prov = null
        continue
      }
      if (typeof raw !== 'string') {
        return NextResponse.json({ ok: false, message: 'Province must be text.' }, { status: 400 })
      }
      const code = cleanText(raw).toUpperCase()
      if (provinceTaxRate(code) === null) {
        return NextResponse.json(
          {
            ok: false,
            message: `"${cleanText(raw)}" is not a province code we can calculate tax for. ` +
              'Use the two-letter code: ON, QC, BC, AB, MB, SK, NS, NB, NL, PE, YT, NT, NU.'
          },
          { status: 400 }
        )
      }
      update.prov = code
      continue
    }

    if (k === 'is_test') {
      // Was a bare pass-through, so any JSON value landed in the column. A row whose
      // is_test is null instead of false is skipped by the archive-on-revoke step in
      // /api/admin/team, which would leave a portal login open.
      if (typeof raw !== 'boolean') {
        return NextResponse.json({ ok: false, message: 'is_test must be true or false.' }, { status: 400 })
      }
      update.is_test = raw
      continue
    }

    if (k === 'school_id') {
      const school = parseSchoolId(raw)
      if (!school.ok) return NextResponse.json({ ok: false, message: school.error }, { status: 400 })
      update.school_id = school.value
      continue
    }

    if (k === 'cohort_id') {
      const cohort = parseCohortId(raw)
      if (!cohort.ok) return NextResponse.json({ ok: false, message: cohort.error }, { status: 400 })
      update.cohort_id = cohort.value
      continue
    }

    // `is_test` and `cohort_id` are validated above; the pair of them is checked after
    // the loop, because whether a move is allowed depends on BOTH the target cohort and
    // the row's test flag.

    if (TEXT_FIELDS.has(k)) {
      if (raw === null || raw === undefined) { update[k] = null; continue }
      if (typeof raw !== 'string') {
        return NextResponse.json({ ok: false, message: `${k} must be text.` }, { status: 400 })
      }
      const clean = cleanText(raw)
      if ((k === 'first_name' || k === 'last_name') && !clean) {
        return NextResponse.json({ ok: false, message: `${k.replace('_', ' ')} cannot be empty.` }, { status: 400 })
      }
      update[k] = clean || null
      continue
    }

    update[k] = raw
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: false, message: 'No valid fields to update' }, { status: 400 })
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  // A TEST ROW MUST NOT BE MOVED INTO A LIVE COHORT.
  //
  // `is_test` does NOT exclude a BAM from invoice generation -- it only relaxes the
  // upload-month rule (lib/period.ts). So a test row sitting in a live cohort is picked
  // up by the monthly run like anybody else: an invoice for a test account, addressed to
  // AP. lib/admin-test-bam.ts refuses to CREATE one outside a TEST cohort for exactly
  // that reason, and this is the other half -- nothing stopped an admin dragging one
  // there afterwards from the roster's cohort dropdown.
  //
  // Today only `send_mode='dryrun'` stands between that and a real AP email, and
  // send_mode is a switch someone will flip on purpose before the first live cycle.
  if ('cohort_id' in update || 'is_test' in update) {
    const { data: cur, error: curErr } = await db
      .from('bams').select('is_test, cohort_id').eq('id', id).limit(1)
    if (curErr) {
      return NextResponse.json(
        { ok: false, message: `Could not check the current cohort: ${curErr.message}` },
        { status: 500 }
      )
    }
    const row = (cur ?? [])[0] as { is_test: boolean | null; cohort_id: string | null } | undefined

    // The state AFTER this edit, since both fields can move in one request.
    const willBeTest = 'is_test' in update ? update.is_test === true : row?.is_test === true
    const targetCohortId = 'cohort_id' in update ? (update.cohort_id as string | null) : (row?.cohort_id ?? null)

    // The cohort is read whenever there IS one, not only when the row is already flagged
    // as a test. It used to be `if (willBeTest && targetCohortId)`, which meant moving an
    // unticked BAM into the TEST cohort skipped this block entirely and left is_test false.
    if (targetCohortId) {
      const { data: cRows, error: cErr } = await db
        .from('cohorts').select('id, name').eq('id', targetCohortId).limit(1)
      if (cErr) {
        return NextResponse.json(
          { ok: false, message: `Could not check that cohort: ${cErr.message}` },
          { status: 500 }
        )
      }
      const target = (cRows ?? [])[0] as { name: string | null } | undefined

      // Landing in a TEST cohort makes it a test row. One direction only: see
      // isTestForCohort for why leaving one is left to fail loudly instead.
      const resolvedIsTest = isTestForCohort(target?.name, willBeTest)
      if (resolvedIsTest !== willBeTest) update.is_test = resolvedIsTest

      // The shared rule (lib/admin-test-bam.ts). It used to be `if (target && ...)` here, which
      // skipped the check when the cohort read back as zero rows: audit finding 20.
      const problem = testRowCohortProblem({
        isTest: resolvedIsTest,
        cohortName: target?.name,
        cohortFound: Boolean(target)
      })
      if (problem) {
        return NextResponse.json({ ok: false, message: problem }, { status: 409 })
      }
    }
  }

  // A BANK CHANGE IS NOT AN ADMIN EDIT ONCE THE STUDENT HAS ONBOARDED.
  //
  // A deposit needs four things that have to agree: bank name, institution number,
  // transit (branch) number and account number. The institution number is a property of
  // the bank, so it can be derived. The TRANSIT and ACCOUNT cannot -- they are the
  // student's branch and their account at it, and nobody else knows them.
  //
  // So changing bank_name here can only ever produce an impossible combination: RBC's
  // institution 003 beside a TD branch and a TD account. An earlier version of this
  // handler derived the institution number on a bank change, which made the PDF read
  // consistently while leaving the money pointed somewhere that does not exist. That was
  // worse than the mismatch it replaced, because it looked right.
  //
  // The correct path already exists and has the student supply all four with Robin
  // confirming: /portal/account -> banking change request -> /admin/banking-requests.
  // This refuses and says so, rather than half-doing it.
  if ('bank_name' in update) {
    const { data: existing, error: exErr } = await db
      .from('bams').select('institution_no, transit_no, account_no, bank_name').eq('id', id).limit(1)
    if (exErr) {
      return NextResponse.json(
        { ok: false, message: `Could not check the current banking details: ${exErr.message}` },
        { status: 500 }
      )
    }
    const row = (existing ?? [])[0] as
      { institution_no: string | null; transit_no: string | null; account_no: string | null; bank_name: string | null } | undefined
    const hasBanking = Boolean(row?.transit_no || row?.account_no)
    const changing = (row?.bank_name ?? null) !== (update.bank_name ?? null)

    if (hasBanking && changing) {
      return NextResponse.json(
        {
          ok: false,
          message:
            'A bank change cannot be made here. The transit (branch) and account numbers ' +
            'belong to the old bank and only the BAM knows the new ones, so changing just ' +
            'the bank name would point the deposit somewhere that does not exist. Ask them ' +
            'to submit a banking change from their portal account, then approve it under ' +
            'Banking changes.'
        },
        { status: 409 }
      )
    }
  }

  // Read back the row so "saved" means the value is actually in the database
  // (ENGINEERING-RULES section 1). `.select()` also tells us whether any row
  // matched: an update that hits 0 rows is not a success.
  const { data, error } = await db
    .from('bams')
    .update(update)
    .eq('id', id)
    .select(READBACK)

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return NextResponse.json(
        { ok: false, message: 'Another BAM already uses that email. Nothing was changed.' },
        { status: 409 }
      )
    }
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ ok: false, message: 'No roster row matched that id.' }, { status: 404 })
  }

  const saved = data[0] as { email: string | null }
  if ('email' in update && saved.email !== update.email) {
    // The trigger or a constraint changed what we asked for. Report it rather
    // than claiming success on a value we did not verify.
    console.error(`[roster PATCH] email read-back mismatch: wrote "${String(update.email)}", stored "${String(saved.email)}"`)
    return NextResponse.json(
      { ok: false, message: 'The saved email did not match what was submitted. Please check the value and try again.' },
      { status: 500 }
    )
  }

  // Changing the bank keeps the institution number in step, but ONLY where there is no
  // banking on file yet. See the guard earlier in this handler for why a bank change on
  // an onboarded BAM is refused instead: the transit number is a branch only the student
  // knows, so bank_name alone can never produce a deposit that works.
  const warnings: string[] = []
  if ('bank_name' in update) {
    const bank = update.bank_name ? lookupBank(String(update.bank_name)) : null
    if (update.bank_name && !bank) {
      // parseBankName already rejects an unknown bank, so this is belt and braces.
      warnings.push('The bank was saved but its institution number could not be resolved. Check it before invoicing.')
    } else if (bank) {
      const { error: encErr } = await db.rpc('encrypt_bam_banking', {
        p_bam_id: id,
        p_institution_no: bank.institutionNo,
        p_transit_no: null,
        p_account_no: null,
        p_hst_number: null
      })
      if (encErr) {
        console.error('[roster PATCH] institution number not updated for', id, encErr.message)
        warnings.push(
          `The bank name was changed to ${bank.displayName}, but its institution number could not be updated ` +
          `(${encErr.message}). Do not invoice this BAM until that is fixed. The deposit would route to the previous bank.`
        )
      } else {
        // Read it back. A silent no-op here is exactly the mismatch this block exists
        // to prevent, and it would only surface on a PDF that had already been sent.
        const { data: dec, error: decErr } = await db.rpc('decrypt_bam_banking', { p_bam_id: id })
        const got = Array.isArray(dec) ? dec[0] : dec
        if (decErr || !got || got.institution_no !== bank.institutionNo) {
          console.error(
            '[roster PATCH] institution read-back mismatch for', id,
            decErr?.message ?? `expected ${bank.institutionNo}`
          )
          warnings.push(
            `The bank name was changed to ${bank.displayName}, but the stored institution number could not be confirmed. ` +
            'Do not invoice this BAM until it is checked.'
          )
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    bam: data[0],
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {})
  })
}

/**
 * POST — add a single BAM to the roster.
 *
 * "+ Add BAM" on /admin/roster used to push a row into React state and toast
 * "Added (local only, DB insert requires admin auth)". There was no POST handler
 * at all, so the row rendered with a PENDING badge, incremented the header counts
 * and was gone on reload. The BAM did not exist, so no invite could be sent and
 * no invoice would ever be generated for them.
 *
 * Initials are resolved with the same ladder bulk-invite uses (lib/initials.ts),
 * via ensureInitialsResolved so the value is claimed with a compare-and-set and
 * can never collide with an already-issued INV number.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }
  const fields = (body ?? {}) as Record<string, unknown>

  const firstName = cleanText(fields.first_name)
  if (!firstName) {
    return NextResponse.json({ ok: false, message: 'First name is required.' }, { status: 400 })
  }
  // Empty last name is allowed (mononyms, and bulk-invite accepts it). The
  // column is NOT NULL, so it is stored as an empty string, never null.
  const lastName = cleanText(fields.last_name)

  const parsedEmail = parseEmail(fields.email)
  if (!parsedEmail.ok) {
    return NextResponse.json({ ok: false, message: parsedEmail.reason }, { status: 400 })
  }

  const cohort = parseCohortId(fields.cohort_id)
  if (!cohort.ok) {
    return NextResponse.json({ ok: false, message: cohort.error }, { status: 400 })
  }

  const school = parseSchoolId(fields.school_id)
  if (!school.ok) return NextResponse.json({ ok: false, message: school.error }, { status: 400 })

  const bank = parseBankName(fields.bank_name)
  if (!bank.ok) return NextResponse.json({ ok: false, message: bank.error }, { status: 400 })

  // Provisional. Upgraded to true below if the target cohort is a TEST cohort, so the
  // checkbox cannot be the thing that decides whether a tester behaves like a tester.
  const isTestRequested = fields.is_test === true
  // Defaults to TRUE when the caller says nothing: the expectation for adding a BAM
  // is that they get invited, and the CSV import already behaves that way. An
  // explicit `false` opts out.
  const sendInvite = fields.send_invite !== false

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  // Cohort must exist: an FK violation would otherwise reach the admin as a raw
  // Postgres string.
  const { data: cohortRows, error: cohortErr } = await db
    .from('cohorts').select('id, name').eq('id', cohort.value)
  if (cohortErr) {
    return NextResponse.json({ ok: false, message: `Could not read cohorts: ${cohortErr.message}` }, { status: 500 })
  }
  if (!cohortRows || cohortRows.length !== 1) {
    return NextResponse.json({ ok: false, message: 'That cohort does not exist. Reload the page.' }, { status: 404 })
  }

  const cohortName = (cohortRows[0] as { name: string | null }).name

  // Adding someone to a TEST cohort makes them a test row, whether or not the checkbox was
  // ticked. See isTestForCohort: an unticked tester is treated as a real BAM by everything
  // that matters, including the deadline exception that lets them upload a receipt at all.
  const isTest = isTestForCohort(cohortName, isTestRequested)

  // AUDIT FINDING 12. The cohort's name was already being read here, purely for the existence
  // check above, and then never looked at. So this route would happily CREATE a test account in
  // a live cohort while PATCH refused to move one there, and GO-LIVE.md claimed both were
  // covered. Same rule, same message, one function.
  const newRowProblem = testRowCohortProblem({
    isTest,
    cohortName,
    cohortFound: true
  })
  if (newRowProblem) {
    return NextResponse.json({ ok: false, message: newRowProblem }, { status: 409 })
  }

  // Pre-check the duplicate so the admin gets a sentence instead of
  // "duplicate key value violates unique constraint bams_email_lower_uniq".
  // The unique index is still the real guard (see UNIQUE_VIOLATION below).
  const { data: clash, error: clashErr } = await db
    .from('bams').select('id, status').ilike('email', parsedEmail.email).limit(1)
  if (clashErr) {
    return NextResponse.json({ ok: false, message: `Could not check for a duplicate email: ${clashErr.message}` }, { status: 500 })
  }
  if (clash && clash.length > 0) {
    return NextResponse.json(
      { ok: false, message: `${parsedEmail.email} is already on the roster. Edit that row instead of adding a second one.` },
      { status: 409 }
    )
  }

  const { data: inserted, error: insertErr } = await db
    .from('bams')
    .insert({
      cohort_id: cohort.value,
      first_name: firstName,
      last_name: lastName,
      email: parsedEmail.email,
      school_id: school.value,
      bank_name: bank.value,
      status: 'pending',
      is_test: isTest
    })
    .select(READBACK)

  if (insertErr) {
    if (insertErr.code === UNIQUE_VIOLATION) {
      return NextResponse.json(
        { ok: false, message: `${parsedEmail.email} is already on the roster. Edit that row instead of adding a second one.` },
        { status: 409 }
      )
    }
    return NextResponse.json({ ok: false, message: `Could not add the BAM: ${insertErr.message}` }, { status: 500 })
  }
  if (!inserted || inserted.length !== 1) {
    return NextResponse.json(
      { ok: false, message: `The insert reported success but returned ${inserted?.length ?? 0} rows. Nothing was added.` },
      { status: 500 }
    )
  }

  const bam = inserted[0] as Record<string, unknown> & { id: string; email: string | null }

  if (bam.email !== parsedEmail.email) {
    console.error(`[roster POST] email read-back mismatch: wrote "${parsedEmail.email}", stored "${String(bam.email)}"`)
    return NextResponse.json(
      { ok: false, message: 'The BAM was created but the stored email does not match what was submitted. Check the roster row before sending an invite.' },
      { status: 500 }
    )
  }

  // Initials failing is not a reason to undo the row (that would be a second
  // write with its own failure mode); it is resolved again at invoice time. Say
  // so instead of hiding it.
  const warnings: string[] = []
  const initials = await ensureInitialsResolved(db, bam.id, cohort.value)
  if (initials.ok) {
    bam.initials_resolved = initials.initials
  } else {
    console.error('[roster POST] initials resolution failed:', initials.error)
    warnings.push('The BAM was added but their invoice initials could not be assigned yet.')
  }

  // Send the invite, if asked. LAST, and only after the row exists and its stored
  // email has been read back and matched -- emailing an address we have not confirmed
  // we stored is how an invite goes to a typo.
  //
  // Adding a BAM used to send nothing while the CSV import sent automatically, with
  // no hint of the difference on screen, so an admin who added one person by hand
  // waited for an email that was never coming. It defaults to on in the UI because
  // that is what the workflow expects, and it is a checkbox because sending mail is
  // an outward action an admin should be able to decline.
  //
  // An email failure never undoes the row: the row is correct and already verified.
  // It is reported instead, with the link, so the admin can pass it on by hand.
  let inviteInfo: Record<string, unknown> = { invite_requested: sendInvite }
  if (sendInvite) {
    const invite = await sendBamInvite(db, {
      id: bam.id,
      email: parsedEmail.email,
      first_name: firstName,
      status: 'pending'
    })
    if (!invite.ok) {
      console.error('[roster POST] invite failed for', bam.id, invite.message)
      warnings.push(invite.message)
      inviteInfo = { ...inviteInfo, email_sent: false, email_error: invite.message }
    } else {
      inviteInfo = {
        ...inviteInfo,
        invite_url: invite.inviteUrl,
        email_sent: invite.emailSent,
        email_provider: invite.emailProvider,
        email_error: invite.emailError
      }
      if (!invite.emailSent) {
        warnings.push(
          `The BAM was added but the invite email did not send (${invite.emailError ?? 'no reason given'}). ` +
          'Copy the invite link and send it to them yourself.'
        )
      }
      const { error: invAuditErr } = await db.from('audit_log').insert({
        actor_id: auth.devBypass ? null : auth.userId,
        actor_role: auth.role,
        entity: 'bams',
        entity_id: bam.id,
        action: 'invite_sent',
        after_json: { email: parsedEmail.email, provider: invite.emailProvider, sent: invite.emailSent }
      })
      if (invAuditErr) console.error('[roster POST] invite audit insert failed:', invAuditErr.message)
    }
  }

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'bams',
    entity_id: bam.id,
    action: 'roster_add',
    after_json: {
      email: parsedEmail.email,
      cohort_id: cohort.value,
      status: 'pending',
      is_test: isTest,
      initials_resolved: initials.ok ? initials.initials : null,
      ...inviteInfo
    }
  })
  if (auditErr) {
    console.error('[roster POST] audit_log insert failed:', auditErr.message)
    warnings.push('The audit log entry could not be written. Tell Mirae.')
  }

  return NextResponse.json({
    ok: true,
    bam,
    cohort_name: (cohortRows[0] as { name: string }).name,
    ...inviteInfo,
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {})
  })
}
