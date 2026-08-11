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
import { ensureInitialsResolved } from '../../../../lib/ensure-initials'
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

  return NextResponse.json({ ok: true, bam: data[0] })
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

  const isTest = fields.is_test === true

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
      initials_resolved: initials.ok ? initials.initials : null
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
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {})
  })
}
