/**
 * GET /api/admin/settings — where email actually goes right now.
 * PUT /api/admin/settings  { to, cc } — change where invoice email goes.
 *
 * WHAT CHANGED, 2026-08-13
 * ------------------------
 * This used to be read-only, and said so: the AP recipient and CC list lived in environment
 * variables, so changing them needed a Vercel edit and a redeploy, and the page could only
 * tell Robin what the values were. It is editable now. Mirae's reasoning: nothing breaks, the
 * only risk is a typo sending someone's pay to the wrong inbox, and Robin is the person who
 * owns that risk. "Ask Mirae" stops working the day Mirae leaves.
 *
 * The rest is still read-only. EMAIL_FROM and REPLY_TO_EMAIL are sender identity, tied to a
 * verified domain, and a wrong value there does not misroute money, it stops mail leaving.
 *
 * THE WRITE REFUSES A BAD ADDRESS RATHER THAN STORING IT.
 * The failure mode this guards is invisible: the send succeeds and the address is wrong. So
 * every address goes through the same addressProblem() the senders use, the write is refused
 * if any fails, and the stored row is READ BACK and compared before this reports success.
 *
 * The addresses are sanitized on the way out for the same reason they are on the way in: a
 * BOM or a trailing space in an env var is invisible and silently misroutes mail, and a
 * settings page that renders it as clean text hides exactly the thing worth seeing.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, requireSuperAdmin, denied } from '../../../../lib/admin-auth'
import { envAddress } from '../../../../lib/sanitize'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import {
  AP_EMAIL_KEY,
  apAddressProblems,
  normalizeApAddresses,
  resolveApAddresses
} from '../../../../lib/ap-addresses'

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  // Resolved through the SAME function the senders call, so this page cannot show one address
  // while the invoice goes to another. That divergence is the entire class of bug here.
  const resolved = await resolveApAddresses(db)
  const from = envAddress('EMAIL_FROM') ?? null
  const replyTo = envAddress('REPLY_TO_EMAIL') ?? null

  if (!resolved.ok) {
    // Say it here rather than at 9am on the 17th when the AP batch is going out.
    return NextResponse.json({
      ok: true,
      invoiceEmail: {
        to: null,
        cc: [],
        from,
        replyTo,
        source: null,
        editable: true,
        problems: [resolved.error]
      }
    })
  }

  return NextResponse.json({
    ok: true,
    invoiceEmail: {
      to: resolved.to,
      cc: resolved.cc,
      from,
      replyTo,
      /** 'policy' means somebody set it here; 'env' means it is still the deployed default. */
      source: resolved.source,
      editable: true,
      problems: []
    }
  })
}

export async function PUT(req: NextRequest) {
  // Super admin only. This is the money path: the address on it decides which inbox receives
  // an invoice, and program_admin is a wider group than the people who own that.
  const auth = await requireSuperAdmin()
  if (!auth.ok) return denied(auth)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 })
  }

  const next = normalizeApAddresses((body ?? {}) as { to?: unknown; cc?: unknown })
  const problems = apAddressProblems(next)
  if (problems.length > 0) {
    // REFUSED, not stored-with-a-warning. A stored bad address is a send to the wrong inbox.
    return NextResponse.json(
      { ok: false, message: 'Nothing was saved.', problems },
      { status: 400 }
    )
  }

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Server is not configured.' }, { status: 503 })
  }

  // The value being replaced, for the audit entry. Read before the write, because after it
  // there is no way to know what it was.
  const before = await resolveApAddresses(db)

  const { data: saved, error } = await db
    .from('policy')
    .upsert(
      {
        key: AP_EMAIL_KEY,
        value_json: { to: next.to, cc: next.cc },
        updated_at: new Date().toISOString(),
        updated_by: auth.devBypass ? null : auth.userId
      },
      { onConflict: 'key' }
    )
    .select('value_json')

  if (error) {
    console.error('[admin/settings PUT] write failed:', error.message)
    return NextResponse.json(
      { ok: false, message: `That did not save: ${error.message}` },
      { status: 500 }
    )
  }
  if ((saved ?? []).length === 0) {
    return NextResponse.json(
      { ok: false, message: 'That did not save: the write affected no rows.' },
      { status: 500 }
    )
  }

  // READ BACK through the resolver, not from the upsert's return value. What matters is not
  // "the row we sent came back" but "the next send will use this", and those are only the same
  // thing if the resolver agrees. A write that reports success while the senders still use the
  // old address is exactly the invisible failure this feature is about.
  const after = await resolveApAddresses(db)
  if (!after.ok) {
    return NextResponse.json(
      { ok: false, message: `Saved, but it does not read back cleanly: ${after.error}` },
      { status: 500 }
    )
  }
  const sameCc =
    after.cc.length === next.cc.length &&
    after.cc.every((v, i) => v.toLowerCase() === next.cc[i].toLowerCase())
  if (after.to.toLowerCase() !== next.to.toLowerCase() || !sameCc) {
    console.error('[admin/settings PUT] read-back mismatch', { wanted: next, got: { to: after.to, cc: after.cc } })
    return NextResponse.json(
      {
        ok: false,
        message: 'That did not save correctly. Reload the page to see what is actually stored.',
        stored: { to: after.to, cc: after.cc }
      },
      { status: 500 }
    )
  }

  // Money-path change, so it is logged with both sides. Logged AFTER the read-back so the
  // entry records what is true rather than what was attempted.
  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'policy',
    entity_id: null,
    action: 'ap_addresses_changed',
    before_json: before.ok ? { to: before.to, cc: before.cc, source: before.source } : { error: before.error },
    after_json: { to: after.to, cc: after.cc, source: after.source }
  })
  if (auditErr) console.error('[admin/settings PUT] audit_log insert failed:', auditErr.message)

  return NextResponse.json({
    ok: true,
    invoiceEmail: { to: after.to, cc: after.cc, source: after.source, problems: [] },
    auditLogged: !auditErr
  })
}
