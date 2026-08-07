/**
 * PATCH /api/admin/roster  { id, ...fields }
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
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import { parseEmail, cleanText } from '../../../../lib/sanitize'

const ALLOWED_FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'status',
  'school_id', 'cohort_id', 'bank_name', 'is_test'
] as const

/** Values the bams.status CHECK constraint accepts. */
const VALID_STATUSES = ['pending', 'active', 'archived'] as const

/** Free-text fields that get invisible-character cleanup but keep their case. */
const TEXT_FIELDS = new Set<string>(['first_name', 'last_name', 'phone', 'bank_name'])

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
    .select('id, email, first_name, last_name, status')

  if (error) {
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
