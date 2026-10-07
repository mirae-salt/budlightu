/**
 * GET  /api/admin/invoices/missing          invoices that cannot be sent yet: the ones that do
 *                                           not exist, and drafts held by a missing address
 *                                           or unfinished onboarding
 * POST /api/admin/invoices/missing { id, period }   create that draft
 *
 * An invoice is normally created on the 1st for every active student, and at the end of
 * onboarding. Lea Major (2026-09) fell between the two: she joined on the 2nd, never
 * finished onboarding, and had an approved reimbursement with no invoice anyone could see.
 * The invoices screen lists everything that exists, so what did not exist was invisible.
 * This lists it, for this month and last, and lets an admin create the draft.
 *
 * Listed: active students with no invoice for the month, and pending students who have
 * receipts for it (a pending student with nothing submitted is just someone who has not
 * started). Test accounts and archived students are never listed.
 *
 * Creating is allowed for a pending student, because the draft cannot leave: batch-approve
 * refuses a pending BAM and an invoice with no address (lib/invoice-address-placeholder),
 * and says which. Missing banking still refuses creation. Nothing here sends anything, and
 * an existing invoice of any status is left alone (seedIfMissing).
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import { periodOf } from '../../../../../lib/seed-period-invoice'
import { joinedAfterMonthEnded } from '../../../../../lib/joined-after-month'
import { seedIfMissing, missingConfirmations, CONFIRMATION_COLUMNS, type ConfirmationRow } from '../../../../../lib/roster-activation'
import { missingAddressFields, addressPendingProblem } from '../../../../../lib/invoice-address-placeholder'

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])-01$/

function monthLabel(period: string): string {
  return new Date(`${period}T00:00:00Z`).toLocaleString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** This month and the one before, as YYYY-MM-01. */
function recentPeriods(now: Date): string[] {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return [periodOf(prev), periodOf(now)]
}

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)
  const db = serviceClient()
  const periods = recentPeriods(new Date())

  const [cohortsRes, bamsRes, invRes, recRes] = await Promise.all([
    db.from('cohorts').select('id, name, start_date, end_date'),
    db.from('bams').select('id, first_name, last_name, status, is_test, created_at, cohort_id, street, city, prov, postal, bank_name')
      .in('status', ['active', 'pending']).eq('is_test', false),
    db.from('invoices').select('bam_id, period, invoice_number, status, payload_json').in('period', periods),
    db.from('receipts').select('bam_id, period').in('period', periods)
  ])
  for (const r of [cohortsRes, bamsRes, invRes, recRes]) {
    if (r.error) return NextResponse.json({ ok: false, message: r.error.message }, { status: 500 })
  }

  const has = new Set((invRes.data ?? []).map(i => `${i.bam_id}|${i.period}`))
  const invByKey = new Map((invRes.data ?? []).map(i => [`${i.bam_id}|${i.period}`, i]))
  const receipts = new Map<string, number>()
  for (const r of recRes.data ?? []) receipts.set(`${r.bam_id}|${r.period}`, (receipts.get(`${r.bam_id}|${r.period}`) ?? 0) + 1)
  const cohorts = new Map((cohortsRes.data ?? []).map(c => [c.id, c]))

  const rows: Array<Record<string, unknown>> = []
  for (const period of periods) {
    for (const b of bamsRes.data ?? []) {
      const c = cohorts.get(b.cohort_id)
      if (!c || period < String(c.start_date) || period > String(c.end_date)) continue
      const key = `${b.id}|${period}`
      const n = receipts.get(key) ?? 0
      // Joined after that month ended and has nothing in it: there was no work to pay for.
      // Hannah and Alivia joined on Oct 5 and 6 and were listed for September.
      if (n === 0 && !has.has(key) && joinedAfterMonthEnded(b.created_at, period)) continue
      if (has.has(key)) {
        // An invoice exists. Listed only when something will stop it being sent, so an
        // ordinary draft waiting for the 17th does not fill this box every month.
        const inv = invByKey.get(key)
        if (!inv || inv.status !== 'draft') continue
        const reasons = [
          addressPendingProblem(inv.payload_json) ? 'no mailing address' : '',
          b.status === 'pending' ? 'onboarding not finished' : ''
        ].filter(Boolean)
        if (reasons.length === 0) continue
        rows.push({
          kind: 'held', id: b.id, name: `${b.first_name ?? ''} ${b.last_name ?? ''}`.trim(),
          status: b.status, cohort: c.name, period, month: monthLabel(period), receipts: n,
          invoice_number: inv.invoice_number, reasons
        })
        continue
      }
      if (b.status === 'pending' && n === 0) continue
      rows.push({
        kind: 'missing',
        id: b.id,
        name: `${b.first_name ?? ''} ${b.last_name ?? ''}`.trim(),
        status: b.status,
        cohort: c.name,
        period,
        month: monthLabel(period),
        receipts: n,
        missing_address: missingAddressFields(b),
        has_bank: Boolean(b.bank_name)
      })
    }
  }
  return NextResponse.json({ ok: true, rows })
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  let body: { id?: unknown; period?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request body' }, { status: 400 })
  }
  const id = typeof body.id === 'string' ? body.id : ''
  const period = typeof body.period === 'string' ? body.period : ''
  if (!id) return NextResponse.json({ ok: false, message: 'id required' }, { status: 400 })
  if (!PERIOD_RE.test(period)) return NextResponse.json({ ok: false, message: 'period must look like 2026-09-01' }, { status: 400 })
  if (period > periodOf(new Date())) return NextResponse.json({ ok: false, message: 'That month has not started yet.' }, { status: 400 })

  const db = serviceClient()
  const { data: rows, error } = await db.from('bams')
    .select(`id, first_name, last_name, status, is_test, cohort_id, ${CONFIRMATION_COLUMNS}`)
    .eq('id', id).limit(1)
  if (error) return NextResponse.json({ ok: false, message: `Could not read the roster row: ${error.message}` }, { status: 500 })
  const bam = (rows ?? [])[0] as
    | ({ id: string; first_name: string; last_name: string; status: string; is_test: boolean; cohort_id: string | null } & ConfirmationRow)
    | undefined
  if (!bam) return NextResponse.json({ ok: false, message: 'No roster row matched that id.' }, { status: 404 })
  if (bam.status !== 'active' && bam.status !== 'pending') {
    return NextResponse.json({ ok: false, message: `${bam.first_name} ${bam.last_name} is ${bam.status}.` }, { status: 409 })
  }
  if (!bam.cohort_id) return NextResponse.json({ ok: false, message: 'This student has no cohort.' }, { status: 409 })

  const out = await seedIfMissing(db, { bamId: bam.id, cohortId: bam.cohort_id, period, monthLabel: monthLabel(period) })

  // A refusal is audited too: who tried, for which month, and what stopped it.
  const { error: auditErr } = await db.from('audit_log').insert({
    actor_id: auth.devBypass ? null : auth.userId,
    actor_role: auth.role,
    entity: 'bams',
    entity_id: bam.id,
    action: 'create_missing_invoice',
    before_json: { period, bam_status: bam.status },
    after_json: { period, ok: out.ok, created: out.created, note: out.note }
  })

  const missing = missingConfirmations(bam)
  return NextResponse.json({
    ok: out.ok,
    created: out.created,
    message: out.note,
    ...(out.created && bam.status === 'pending'
      ? { hold: 'This student has not finished onboarding, so the invoice cannot be sent until they do or you set them active on the roster.' }
      : {}),
    ...(out.created && missing.length > 0 ? { missing_confirmations: missing } : {}),
    ...(auditErr ? { warning: 'The invoice step ran, but its audit log entry could not be written. Tell Mirae.' } : {})
  }, { status: out.ok ? 200 : 422 })
}
