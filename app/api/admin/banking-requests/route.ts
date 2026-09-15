/**
 * GET /api/admin/banking-requests
 *
 * The review queue for BAM banking corrections. Returns, for each open request,
 * the values currently on file next to the values being asked for, so the
 * difference is visible rather than inferred.
 *
 * This endpoint decrypts banking values on purpose: the admin has to READ the
 * requested account number (they retype it to approve, see ../decide) and has to
 * see the current one to judge whether the change looks like a typo fix or like
 * someone redirecting a student's pay. It is admin-only (requireAdmin, role from
 * app_metadata only) and is never cached.
 *
 * Decided requests are listed without values: once a decision is made there is
 * nothing to compare, and shipping the digits again has no purpose.
 */
import { NextResponse } from 'next/server'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import { lookupBank } from '../../../../lib/banks'

type BamJoin = { first_name: string; last_name: string; email: string; bank_name: string | null; cohort_id: string | null; is_test: boolean | null }
type RequestRow = {
  id: string
  bam_id: string
  status: string
  reason: string
  bank_name: string
  requested_at: string
  decided_at: string | null
  decision_note: string | null
  bams: BamJoin | BamJoin[] | null
}

function firstBam(j: RequestRow['bams']): BamJoin | null {
  if (!j) return null
  return Array.isArray(j) ? (j[0] ?? null) : j
}

const noStore = { headers: { 'Cache-Control': 'no-store, max-age=0' } }

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let db
  try {
    db = serviceClient()
  } catch {
    return NextResponse.json({ ok: false, message: 'Service role key not configured' }, { status: 500 })
  }

  const { data: rows, error } = await db.from('banking_change_requests')
    .select('id, bam_id, status, reason, bank_name, requested_at, decided_at, decision_note, bams(first_name, last_name, email, bank_name, cohort_id, is_test)')
    .order('requested_at', { ascending: false })
    .limit(100)
  if (error) {
    console.error('[admin/banking-requests] list failed:', error.message)
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  }

  const { data: cohortRows, error: cohortErr } = await db.from('cohorts').select('id, name')
  if (cohortErr) console.error('[admin/banking-requests] cohorts read failed:', cohortErr.message)
  const cohortNameById = new Map(((cohortRows ?? []) as { id: string; name: string }[]).map(c => [c.id, c.name]))

  const all = (rows ?? []) as unknown as RequestRow[]

  // Decided rows' before/after: written once by decide/route.ts to audit_log
  // (entity='banking_change_requests', entity_id=request.id) at the moment of
  // the decision. Fetched in one pass rather than per-row, since there can be
  // up to 100 of these. Re-decrypting full account numbers here was deliberately
  // never the plan -- the audit row already carries only what decide/route.ts
  // chose to keep (account_last4, not the full number).
  const decidedIds = all.filter(r => r.status !== 'pending').map(r => r.id)
  const auditByRequestId = new Map<string, { before: unknown; after: unknown }>()
  if (decidedIds.length > 0) {
    // Two audit rows can exist per request: 'submitted' (written by the BAM's own
    // request, before_json always null) and the DECISION itself ('applied' or
    // 'rejected'). Without this filter, an unordered query could let 'submitted'
    // win the map below and show every BEFORE value as "not readable".
    const { data: auditRows, error: auditErr } = await db.from('audit_log')
      .select('entity_id, action, before_json, after_json')
      .eq('entity', 'banking_change_requests')
      .in('entity_id', decidedIds)
      .in('action', ['applied', 'rejected'])
    if (auditErr) {
      console.error('[admin/banking-requests] audit_log read failed:', auditErr.message)
    } else {
      for (const a of (auditRows ?? []) as { entity_id: string; before_json: unknown; after_json: unknown }[]) {
        auditByRequestId.set(a.entity_id, { before: a.before_json, after: a.after_json })
      }
    }
  }

  const pending: unknown[] = []
  const decided: unknown[] = []

  for (const r of all) {
    const bam = firstBam(r.bams)
    const who = {
      id: r.id,
      bam_id: r.bam_id,
      status: r.status,
      reason: r.reason,
      requested_at: r.requested_at,
      decided_at: r.decided_at,
      decision_note: r.decision_note,
      bam_name: bam ? `${bam.first_name} ${bam.last_name}` : 'Unknown BAM',
      bam_email: bam?.email ?? null,
      cohort_id: bam?.cohort_id ?? null,
      cohort_name: bam?.cohort_id ? (cohortNameById.get(bam.cohort_id) ?? 'Unknown cohort') : 'Unassigned',
      is_test: bam?.is_test ?? false
    }

    if (r.status !== 'pending') {
      const audit = auditByRequestId.get(r.id) ?? null
      decided.push({
        ...who,
        requested_bank_name: r.bank_name,
        audit_before: audit?.before ?? null,
        audit_after: audit?.after ?? null
      })
      continue
    }

    // Requested values.
    const { data: reqDec, error: reqErr } = await db
      .rpc('decrypt_banking_request', { p_request_id: r.id }).single()
    // Current values on file.
    const { data: curDec, error: curErr } = await db
      .rpc('decrypt_bam_banking', { p_bam_id: r.bam_id }).single()

    if (reqErr) console.error('[admin/banking-requests] decrypt request failed:', r.id, reqErr.message)
    if (curErr) console.error('[admin/banking-requests] decrypt current failed:', r.bam_id, curErr.message)

    const req = (reqDec ?? {}) as { institution_no?: string | null; transit_no?: string | null; account_no?: string | null }
    const cur = (curDec ?? {}) as { institution_no?: string | null; transit_no?: string | null; account_no?: string | null }

    const expected = lookupBank(r.bank_name)?.institutionNo ?? null

    pending.push({
      ...who,
      current: {
        bank_name: bam?.bank_name ?? null,
        // A decryption failure shows as null and the UI says so. It must never
        // render as an empty string that looks like "no value on file".
        institution_no: curErr ? null : (cur.institution_no ?? null),
        transit_no: curErr ? null : (cur.transit_no ?? null),
        account_no: curErr ? null : (cur.account_no ?? null)
      },
      requested: {
        bank_name: r.bank_name,
        institution_no: reqErr ? null : (req.institution_no ?? null),
        transit_no: reqErr ? null : (req.transit_no ?? null),
        account_no: reqErr ? null : (req.account_no ?? null)
      },
      expected_institution_no: expected,
      institution_mismatch: Boolean(expected && req.institution_no && req.institution_no !== expected),
      read_error: reqErr ? `Requested values could not be decrypted: ${reqErr.message}` : null,
      current_read_error: curErr ? `Current values could not be decrypted: ${curErr.message}` : null
    })
  }

  return NextResponse.json({ ok: true, pending, decided }, noStore)
}
