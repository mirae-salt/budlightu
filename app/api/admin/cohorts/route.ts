/**
 * CRUD /api/admin/cohorts
 * POST   — create a new cohort
 * PATCH  — update cohort settings (send_mode, bam_copy_mode, program_label, po_number, salary_default)
 *
 * AUDIT-2026-08-07 fixes:
 *  - P1-19: po_number was stored unvalidated, so whitespace / NBSP / a BOM flowed
 *    straight into the PDF "JOB NUMBER" field and the AP email. AP's automation
 *    parses that value; a broken parse looks perfectly fine in our UI. It is now
 *    sanitized and must match ^\d{6}$ (Robin confirmed 260351).
 *  - P1-20: salary_default was missing from POST entirely while the column is
 *    NOT NULL with no default, so creating a cohort from the admin UI always
 *    failed. It is now required on create, allowed on PATCH, and validated as a
 *    positive amount ($218.75 school year / $250 summer).
 *  - P0-A: authorization used to be a local `requireAdmin()` that read
 *    `user_metadata.role` (client-writable) AND waved every request through
 *    whenever NODE_ENV was development, with no ALLOW_DEV_AUTH_BYPASS gate. It is
 *    now the shared helper: app_metadata only, dev bypass needs both flags.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import { sanitizePoNumber } from '../../../../lib/sanitize'
/** Money amounts stay numbers here; account/transit/institution never appear in
 *  this route. parseAmount moved to lib/admin-input.ts so the rule that made
 *  every cohort create fail is unit tested. */
import { parseAmount } from '../../../../lib/admin-input'

const SEND_MODES = ['dryrun', 'live']
const BAM_COPY_MODES = ['off', 'draft', 'live']

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const body = await req.json()
  const { name, program_label, po_number, start_date, end_date, reimbursement_max, salary_default } = body

  if (!name?.trim() || !start_date || !end_date) {
    return NextResponse.json({ ok: false, message: 'name, start_date, end_date required' }, { status: 400 })
  }

  // P1-20: required, and the column is NOT NULL with no default.
  const salary = parseAmount(salary_default)
  if (!salary.ok) {
    return NextResponse.json(
      { ok: false, message: `Monthly salary ${salary.error} (218.75 for the school year, 250 for summer BAMs).` },
      { status: 400 }
    )
  }

  // P1-19: optional at create (cohorts start without a PO), but if supplied it
  // must be exactly 6 digits with no invisible characters.
  let poNumber: string | null = null
  if (po_number !== undefined && po_number !== null && po_number !== '') {
    const po = sanitizePoNumber(po_number)
    if (!po.ok) return NextResponse.json({ ok: false, message: po.error }, { status: 400 })
    poNumber = po.value
  }

  let reimbursementMax = 150
  if (reimbursement_max !== undefined && reimbursement_max !== null && reimbursement_max !== '') {
    const rm = parseAmount(reimbursement_max)
    if (!rm.ok) return NextResponse.json({ ok: false, message: `reimbursement_max ${rm.error}` }, { status: 400 })
    reimbursementMax = rm.value
  }

  const admin = serviceClient()
  const { data, error } = await admin.from('cohorts').insert({
    name: name.trim(),
    program_label: program_label || name.trim(),
    po_number: poNumber,
    start_date,
    end_date,
    send_mode: 'dryrun',
    /*
     * 'off', not 'draft'. Mirae, 2026-08-13: *"어차피 BAM 이 홈피에서 다운받을 수 있잖아."*
     *
     * A student already has two ways to hold their invoice: they are CC'd on the email to
     * accounts payable, which carries the same PDF, and /portal/invoices offers a Download on
     * anything past draft (verified: the route is requireBam plus an ownership check, and the
     * page shows the button for status !== 'draft'). A third email carrying the same document
     * is noise.
     *
     * `send_mode` stays 'dryrun' because that one guards real money leaving. This one only
     * decides whether a student gets a second copy of something they can already reach, so the
     * quiet default is the right one. Turning it back on is one field on the Cohorts page.
     */
    bam_copy_mode: 'off',
    salary_default: salary.value,
    reimbursement_max: reimbursementMax
  }).select().single()

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, data })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const { id } = await req.json()
  if (!id) return NextResponse.json({ ok: false, message: 'id required' }, { status: 400 })

  const admin = serviceClient()

  const { count, error: countErr } = await admin.from('bams').select('id', { count: 'exact', head: true }).eq('cohort_id', id)
  if (countErr) return NextResponse.json({ ok: false, error: countErr.message }, { status: 500 })
  if (count && count > 0) {
    return NextResponse.json({ ok: false, message: `Cannot delete: ${count} BAMs still assigned` }, { status: 409 })
  }

  const { error } = await admin.from('cohorts').delete().eq('id', id)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const body = await req.json()
  const { id, ...patch } = body
  if (!id) return NextResponse.json({ ok: false, message: 'id required' }, { status: 400 })

  const allowed = [
    'name', 'program_label', 'po_number', 'send_mode', 'bam_copy_mode',
    'start_date', 'end_date', 'reimbursement_max', 'salary_default'
  ]
  const cleanPatch: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in patch) cleanPatch[key] = patch[key]
  }

  if (Object.keys(cleanPatch).length === 0) {
    return NextResponse.json({ ok: false, message: 'no updatable fields provided' }, { status: 400 })
  }

  // P1-19 — validated on update too: this is the path Robin actually uses to set
  // the PO, and the value goes straight onto the PDF and into the AP email.
  if ('po_number' in cleanPatch) {
    const raw = cleanPatch.po_number
    if (raw === null || raw === '') {
      cleanPatch.po_number = null
    } else {
      const po = sanitizePoNumber(raw)
      if (!po.ok) return NextResponse.json({ ok: false, message: po.error }, { status: 400 })
      cleanPatch.po_number = po.value
    }
  }

  for (const key of ['salary_default', 'reimbursement_max'] as const) {
    if (key in cleanPatch) {
      const amount = parseAmount(cleanPatch[key])
      if (!amount.ok) return NextResponse.json({ ok: false, message: `${key} ${amount.error}` }, { status: 400 })
      cleanPatch[key] = amount.value
    }
  }

  if ('send_mode' in cleanPatch && !SEND_MODES.includes(String(cleanPatch.send_mode))) {
    return NextResponse.json({ ok: false, message: `send_mode must be one of ${SEND_MODES.join(', ')}` }, { status: 400 })
  }
  if ('bam_copy_mode' in cleanPatch && !BAM_COPY_MODES.includes(String(cleanPatch.bam_copy_mode))) {
    return NextResponse.json({ ok: false, message: `bam_copy_mode must be one of ${BAM_COPY_MODES.join(', ')}` }, { status: 400 })
  }

  const admin = serviceClient()
  const { data, error } = await admin.from('cohorts').update(cleanPatch).eq('id', id).select().single()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, data })
}
