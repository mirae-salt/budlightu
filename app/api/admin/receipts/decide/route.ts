/**
 * POST /api/admin/receipts/decide
 *   { receipt_id, decision: 'approved'|'rejected', reason: string, override_total?: number }
 *
 * Touchpoint 1. Reason required.
 *
 * P0-F (audit 2026-08-07): `override_total` is the missing half of touchpoint 1.
 *   Before this, decide could only set a status, so there was NO path anywhere in the
 *   codebase to correct an amount the model got wrong. CLAUDE.md's "Robin can override
 *   any result" was unimplemented. An override rewrites bud_light_total_incl_tax, is
 *   written to audit_log with the before/after amounts, and the ledger is recomputed
 *   from the corrected value.
 *
 * P0-H: the reimbursement_ledger upsert is the write that decides what a BAM is paid.
 *   Its error is now checked, the row is read back, and if it fails the receipt status
 *   is rolled back so the UI can never say "Reimbursement confirmed" without a ledger row.
 */
import { NextRequest, NextResponse, after } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import { computeMonthlyReimbursement } from '../../../../../lib/reimbursement'
import { DEFAULT_POLICY, shortfallWarnBelow } from '../../../../../lib/policy'
import { sendEmail } from '../../../../../lib/send-email'
import { appBaseUrl } from '../../../../../lib/app-url'
import { parseNonNegativeMoney } from '../../../../../lib/money'
import { flagShortfall } from '../../../../../lib/shortfall-warning'
import { cleanEnvValue } from '../../../../../lib/sanitize'

/** Sanity ceiling for a manual amount correction. A single receipt above this is a typo. */
const MAX_OVERRIDE_CAD = 5000

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { receipt_id, decision, reason, override_total } = body
  if (!receipt_id || !['approved', 'rejected'].includes(decision) || !reason || reason.length < 3) {
    return NextResponse.json({ ok: false, message: 'receipt_id, decision, and reason (>=3 chars) required' }, { status: 400 })
  }

  // P0-F (d): validate the override before anything is written.
  let overrideTotal: number | null = null
  if (override_total !== undefined && override_total !== null && override_total !== '') {
    if (decision !== 'approved') {
      return NextResponse.json({ ok: false, message: 'override_total only applies when approving a receipt' }, { status: 400 })
    }
    overrideTotal = parseNonNegativeMoney(override_total)
    if (overrideTotal === null) {
      return NextResponse.json({ ok: false, message: 'override_total must be a non-negative number' }, { status: 400 })
    }
    if (overrideTotal > MAX_OVERRIDE_CAD) {
      return NextResponse.json({ ok: false, message: `override_total above $${MAX_OVERRIDE_CAD} is rejected as a likely typo` }, { status: 400 })
    }
  }

  // Touchpoint 1 is an admin action. P0-A: role from app_metadata only.
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const admin = serviceClient()
  // decided_by is a uuid column, so the dev bypass (which has no real session)
  // records the nil uuid rather than a placeholder string.
  const decidedBy = auth.devBypass ? '00000000-0000-0000-0000-000000000000' : auth.userId

  const { data: receipt, error: receiptErr } = await admin.from('receipts')
    .select('bam_id, cohort_id, period, bud_light_total_incl_tax, status')
    .eq('id', receipt_id).maybeSingle()
  if (receiptErr) return NextResponse.json({ ok: false, error: receiptErr.message }, { status: 500 })
  if (!receipt) return NextResponse.json({ ok: false, message: 'receipt not found' }, { status: 404 })
  if (!['pending', 'review', 'ocr_failed'].includes(receipt.status)) {
    return NextResponse.json({ ok: false, message: `receipt already decided (status: ${receipt.status})` }, { status: 409 })
  }

  const previousStatus: string = receipt.status
  const previousTotal = parseNonNegativeMoney(receipt.bud_light_total_incl_tax)

  // P0-F (d): the corrected amount, if Robin supplied one, is what gets stored and
  // what the ledger is computed from.
  const effectiveTotal = overrideTotal !== null ? overrideTotal : previousTotal
  const overrideApplied = overrideTotal !== null && overrideTotal !== previousTotal

  const decisionNote = overrideTotal !== null
    ? `${reason} [amount corrected by admin: ${previousTotal === null ? 'none' : `$${previousTotal.toFixed(2)}`} -> $${overrideTotal.toFixed(2)}]`
    : reason

  const updatePayload: Record<string, unknown> = {
    status: decision,
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
    decision_reason: decisionNote
  }
  if (overrideTotal !== null) updatePayload.bud_light_total_incl_tax = overrideTotal

  const { data: updated, error } = await admin.from('receipts')
    .update(updatePayload)
    .eq('id', receipt_id)
    .select('id, status, bud_light_total_incl_tax')
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  if (!updated || updated.length !== 1) {
    return NextResponse.json({ ok: false, error: `decision write affected ${updated?.length ?? 0} rows, expected 1` }, { status: 500 })
  }
  // Read-back: the stored amount must be the amount we intended to store.
  const storedTotal = parseNonNegativeMoney(updated[0].bud_light_total_incl_tax)
  if (overrideTotal !== null && storedTotal !== overrideTotal) {
    return NextResponse.json({
      ok: false,
      error: `amount override did not persist (stored ${String(updated[0].bud_light_total_incl_tax)}, expected ${overrideTotal})`
    }, { status: 500 })
  }

  // P0-F (d): the override must be in the audit trail. receipts has no audit trigger
  // (0004 only covers invoices/ledger/sends/cancellations/bams/policy), so write it here.
  if (overrideTotal !== null) {
    // The trusted role from lib/admin-auth. There is no user_metadata fallback:
    // a role that only exists in the client-writable bag is not a role (P0-A).
    const actorRole = auth.role

    const { error: auditErr } = await admin.from('audit_log').insert({
      actor_id: auth.devBypass ? null : auth.userId,
      actor_role: actorRole,
      entity: 'receipts',
      entity_id: receipt_id,
      action: 'override_total',
      before_json: {
        bud_light_total_incl_tax: previousTotal,
        status: previousStatus
      },
      after_json: {
        bud_light_total_incl_tax: overrideTotal,
        status: decision,
        reason,
        overridden_by: auth.email ?? decidedBy
      }
    })
    if (auditErr) {
      // An unlogged money correction is not acceptable: undo and refuse.
      await admin.from('receipts').update({
        status: previousStatus,
        bud_light_total_incl_tax: previousTotal,
        decided_by: null,
        decided_at: null,
        decision_reason: `override rolled back: audit log write failed (${auditErr.message})`
      }).eq('id', receipt_id)
      return NextResponse.json({
        ok: false,
        error: `amount override refused: could not write the audit log entry (${auditErr.message})`
      }, { status: 500 })
    }
  }

  // P1-12: the admin UI tells the reviewer "the BAM will be notified", so the send
  // result has to be reported. It used to be `.catch(() => {})` with the result discarded.
  let bamNotified: boolean | null = null
  let bamNotifyError: string | undefined

  if (decision === 'rejected') {
    const { data: bam, error: bamErr } = await admin.from('bams')
      .select('first_name, email').eq('id', receipt.bam_id).maybeSingle()
    if (bamErr) {
      bamNotified = false
      bamNotifyError = `could not look up the BAM: ${bamErr.message}`
      console.error('[decide] bam lookup for rejection email failed:', bamErr.message)
    } else if (!bam?.email) {
      bamNotified = false
      bamNotifyError = 'no email address on file for this BAM'
    }
    if (bam?.email) {
      const period = new Date(receipt.period + 'T00:00:00')
      const monthLabel = period.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      const notify = await sendEmail({
        to: bam.email,
        subject: `Bud Light U - Receipt not accepted for ${monthLabel}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
            <p style="font-size: 16px; color: #1a1a2e;">Hi ${bam.first_name},</p>
            <p style="font-size: 14px; color: #374151; line-height: 1.6;">
              A receipt you submitted for <strong>${monthLabel}</strong> was not accepted during review.
            </p>
            <p style="font-size: 14px; color: #374151; line-height: 1.6;">
              <strong>Reason:</strong> ${reason}
            </p>
            <p style="font-size: 14px; color: #374151; line-height: 1.6;">
              If you have a different Bud Light receipt for this month, you can still upload it
              through the BAM Portal before the review deadline. If you think this was a mistake,
              please reach out to your program manager.
            </p>
            <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">Bud Light U Program</p>
          </div>
        `,
        text: `Hi ${bam.first_name},\n\nA receipt you submitted for ${monthLabel} was not accepted.\n\nReason: ${reason}\n\nIf you have a different Bud Light receipt, you can upload it before the deadline. If you think this was a mistake, reach out to your program manager.\n\nBud Light U Program`
      })
      bamNotified = notify.sent
      if (!notify.sent) bamNotifyError = notify.error ?? `provider ${notify.provider} did not confirm the send`
    }
  }

  let softFloorBreach = false
  let softFloorValue = shortfallWarnBelow(DEFAULT_POLICY)
  let totalSpentThisPeriod = 0
  let ledgerPaid: number | null = null

  if (decision === 'approved' && effectiveTotal != null) {
    // P0-H: an unreadable cohort must NOT fall back to DEFAULT_POLICY. A cohort with
    // reimbursement_max = 100 would otherwise be paid the $150 default.
    const { data: cohort, error: cohortErr } = await admin.from('cohorts')
      .select('reimbursement_max, rollover_mode, cap_multiplier').eq('id', receipt.cohort_id).maybeSingle()
    if (cohortErr || !cohort) {
      await rollbackDecision(admin, receipt_id, previousStatus, previousTotal, overrideTotal !== null,
        `cohort policy unreadable (${cohortErr?.message ?? 'no cohort row'})`)
      return NextResponse.json({
        ok: false,
        error: `cannot compute reimbursement: cohort policy could not be read (${cohortErr?.message ?? 'no cohort row'}). The decision was rolled back.`
      }, { status: 500 })
    }
    const cohortMax = parseNonNegativeMoney(cohort.reimbursement_max)
    const cohortMultiplier = Number(cohort.cap_multiplier)
    if (cohortMax === null || cohortMax <= 0 || !Number.isFinite(cohortMultiplier) || cohortMultiplier <= 0) {
      await rollbackDecision(admin, receipt_id, previousStatus, previousTotal, overrideTotal !== null,
        'cohort reimbursement_max / cap_multiplier is not a usable number')
      return NextResponse.json({
        ok: false,
        error: `cannot compute reimbursement: cohort reimbursement_max="${String(cohort.reimbursement_max)}" cap_multiplier="${String(cohort.cap_multiplier)}". The decision was rolled back.`
      }, { status: 500 })
    }

    const policy = {
      ...DEFAULT_POLICY,
      reimbursementMax: cohortMax,
      rolloverMode: (cohort.rollover_mode ?? DEFAULT_POLICY.rolloverMode) as 'accumulate' | 'forfeit',
      capMultiplier: cohortMultiplier,
      firstCohortAllReview: false // classifier-only flag, not relevant to ledger math
    }

    // Sum ALL approved (+ auto_pass) receipts for this bam/period, not just this one —
    // the ledger reflects the whole month, and a BAM may submit multiple receipts.
    const { data: monthReceipts, error: monthErr } = await admin.from('receipts')
      .select('bud_light_total_incl_tax, status')
      .eq('bam_id', receipt.bam_id).eq('period', receipt.period)
      .in('status', ['approved', 'auto_pass'])
    if (monthErr) {
      await rollbackDecision(admin, receipt_id, previousStatus, previousTotal, overrideTotal !== null,
        `could not sum this period's receipts (${monthErr.message})`)
      return NextResponse.json({
        ok: false,
        error: `cannot compute reimbursement: this period's receipts could not be summed (${monthErr.message}). The decision was rolled back.`
      }, { status: 500 })
    }
    let receiptsTotal = 0
    for (const r of monthReceipts ?? []) {
      const v = parseNonNegativeMoney(r.bud_light_total_incl_tax)
      if (v !== null) receiptsTotal = Math.round((receiptsTotal + v) * 100) / 100
    }
    totalSpentThisPeriod = receiptsTotal

    const { data: prior, error: priorErr } = await admin.from('reimbursement_ledger')
      .select('*').eq('bam_id', receipt.bam_id).lt('period', receipt.period)
      .order('period', { ascending: true })
    if (priorErr) {
      await rollbackDecision(admin, receipt_id, previousStatus, previousTotal, overrideTotal !== null,
        `could not read the prior ledger (${priorErr.message})`)
      return NextResponse.json({
        ok: false,
        error: `cannot compute reimbursement: prior ledger unreadable (${priorErr.message}). The decision was rolled back.`
      }, { status: 500 })
    }
    const priorLedger = (prior ?? []).map(p => ({
      period: p.period,
      entitlementCad: Number(p.entitlement_cad),
      spentCad: Number(p.spent_cad),
      carryoverInCad: Number(p.carryover_in_cad),
      carryoverOutCad: Number(p.carryover_out_cad),
      paidCad: Number(p.paid_cad),
      spendableCapCad: Number(p.spendable_cap_cad),
      capSnapshotCad: Number(p.cap_snapshot_cad),
      shortfallFlag: p.shortfall_flag,
      policyVersion: p.policy_version
    }))
    const monthsActive = priorLedger.length + 1

    const out = computeMonthlyReimbursement({
      period: receipt.period,
      monthsActiveThroughPeriod: monthsActive,
      receiptsTotalInclHst: receiptsTotal,
      priorLedger,
      policy
    })
    // Soft-floor breach (for the warning email) is distinct from the ledger's
    // shortfallFlag (spent < full entitlement) — the warning only fires when
    // spend falls below entitlement - reviewBandPadding (e.g. $150 - $10 = $140).
    softFloorValue = shortfallWarnBelow(policy)
    softFloorBreach = receiptsTotal < softFloorValue

    // P0-H: THIS is the write that decides what the BAM is paid. Its error was
    // discarded, so the receipt could flip to 'approved' with no ledger row while the
    // admin UI displayed "Reimbursement confirmed". Checked, read back, and rolled
    // back on failure.
    const { data: ledgerRows, error: ledgerErr } = await admin.from('reimbursement_ledger').upsert({
      bam_id: receipt.bam_id,
      cohort_id: receipt.cohort_id,
      period: receipt.period,
      entitlement_cad: out.entitlement,
      spent_cad: receiptsTotal,
      carryover_in_cad: out.carryoverIn,
      carryover_out_cad: out.carryoverOut,
      paid_cad: out.paidThisMonth,
      spendable_cap_cad: out.spendableCap,
      cap_snapshot_cad: out.capSnapshot,
      shortfall_flag: out.shortfallFlag,
      policy_version: policy.policyVersion,
      created_by: 'system'
    }, { onConflict: 'bam_id,cohort_id,period' })
      .select('id, paid_cad, spent_cad')

    if (ledgerErr) {
      await rollbackDecision(admin, receipt_id, previousStatus, previousTotal, overrideTotal !== null,
        `reimbursement ledger write failed (${ledgerErr.message})`)
      return NextResponse.json({
        ok: false,
        error: `reimbursement could not be recorded (${ledgerErr.message}). The approval was rolled back, nothing was paid.`
      }, { status: 500 })
    }
    if (!ledgerRows || ledgerRows.length !== 1) {
      await rollbackDecision(admin, receipt_id, previousStatus, previousTotal, overrideTotal !== null,
        `reimbursement ledger write affected ${ledgerRows?.length ?? 0} rows`)
      return NextResponse.json({
        ok: false,
        error: `reimbursement ledger write affected ${ledgerRows?.length ?? 0} rows, expected 1. The approval was rolled back.`
      }, { status: 500 })
    }
    const persistedPaid = parseNonNegativeMoney(ledgerRows[0].paid_cad)
    if (persistedPaid === null || Math.abs(persistedPaid - out.paidThisMonth) > 0.005) {
      await rollbackDecision(admin, receipt_id, previousStatus, previousTotal, overrideTotal !== null,
        `ledger stored paid_cad=${String(ledgerRows[0].paid_cad)} but expected ${out.paidThisMonth}`)
      return NextResponse.json({
        ok: false,
        error: `ledger read-back mismatch: stored $${String(ledgerRows[0].paid_cad)}, expected $${out.paidThisMonth.toFixed(2)}. The approval was rolled back.`
      }, { status: 500 })
    }
    ledgerPaid = persistedPaid
  }

  // Auto-upsert draft invoice when approving. Scheduled with after() so the promise
  // is not dropped when the response is flushed (P1-13 class).
  if (decision === 'approved') {
    scheduleBackground(async () => {
      try {
        const { upsertDraftInvoice } = await import('@/lib/draft-invoice')
        await upsertDraftInvoice(admin, receipt.bam_id, receipt.cohort_id, receipt.period)
      } catch (e) {
        console.error('[decide] draft invoice upsert failed:', e)
      }
    })
  }

  // Trigger shortfall warning if approved but below soft floor.
  // P1-12: the Robin flag now runs in-process (flagShortfall) instead of an unawaited
  // self-fetch, so its result is real. The BAM-facing email keeps its own route but is
  // scheduled with after() and its outcome is logged rather than swallowed.
  let shortfallFlagged: boolean | null = null
  let shortfallFlagError: string | undefined
  if (decision === 'approved' && softFloorBreach) {
    const flag = await flagShortfall(admin, {
      bamId: receipt.bam_id,
      cohortId: receipt.cohort_id,
      period: receipt.period,
      spent: totalSpentThisPeriod,
    })
    shortfallFlagged = flag.ok
    if (!flag.ok) shortfallFlagError = flag.error ?? flag.notifyError

    const baseUrl = req.nextUrl?.origin || appBaseUrl()
    // The shortfall-warning route is no longer anonymous (P0-A). This self-fetch
    // carries no cookies, so it authenticates with the internal shared secret.
    const internalSecret = cleanEnvValue(process.env.INTERNAL_API_SECRET)
    scheduleBackground(async () => {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (internalSecret) headers['x-internal-secret'] = internalSecret
        const resp = await fetch(`${baseUrl}/api/admin/receipts/shortfall-warning`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ receipt_id })
        })
        if (!resp.ok) console.error('[decide] shortfall-warning returned', resp.status, await resp.text().catch(() => ''))
      } catch (e) {
        console.error('[decide] shortfall-warning call failed:', e)
      }
      try {
        const { notifyAdmin } = await import('@/lib/notify-admin')
        await notifyAdmin({
          type: 'shortfall',
          title: 'Shortfall detected',
          body: `$${totalSpentThisPeriod.toFixed(2)} spent, under the $${softFloorValue.toFixed(2)} soft floor`,
          bam_id: receipt.bam_id,
          cohort_id: receipt.cohort_id,
          period: receipt.period,
          link: '/admin/receipts'
        })
      } catch (e) {
        console.error('[decide] notifyAdmin failed:', e)
      }
    })
  }

  return NextResponse.json({
    ok: true,
    status: decision,
    stored_total: storedTotal,
    override_applied: overrideApplied,
    ledger_paid_cad: ledgerPaid,
    bam_notified: bamNotified,
    ...(bamNotifyError ? { bam_notify_error: bamNotifyError } : {}),
    shortfall_flagged: shortfallFlagged,
    ...(shortfallFlagError ? { shortfall_flag_error: shortfallFlagError } : {}),
  })
}

/** after() when inside a request scope, inline otherwise (scripts / tests). */
function scheduleBackground(fn: () => Promise<void>) {
  try {
    after(fn)
  } catch {
    void fn()
  }
}

/**
 * Undo the receipt decision when a downstream money write fails. Without this the
 * receipt stays 'approved' with no ledger row, which is the exact state that makes
 * the admin UI claim a reimbursement that does not exist.
 */
async function rollbackDecision(
  admin: ReturnType<typeof serviceClient>,
  receiptId: string,
  previousStatus: string,
  previousTotal: number | null,
  restoreTotal: boolean,
  why: string
) {
  const payload: Record<string, unknown> = {
    status: previousStatus,
    decided_by: null,
    decided_at: null,
    decision_reason: `decision rolled back: ${why}`.slice(0, 1000)
  }
  if (restoreTotal) payload.bud_light_total_incl_tax = previousTotal
  const { error } = await admin.from('receipts').update(payload).eq('id', receiptId)
  if (error) {
    console.error('[decide] ROLLBACK FAILED for receipt', receiptId, error.message,
      '- receipt may be approved without a ledger row; manual check required')
  }
}
