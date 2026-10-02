/**
 * Server-side admin data fetcher — bypasses RLS using the service role key.
 * Returns data for all admin pages so the client never queries Supabase directly.
 *
 * GET /api/admin/data?table=bams|receipts|invoices|cohorts|unmatched|audit|dashboard
 *                          |notifications|bam_spending
 *
 * P1-9b: this route holds the service role key, so it must authorize itself.
 * It used to rely entirely on middleware, and middleware used to fail OPEN when
 * an env var was missing (P0-A2). It also returned `invite_token_hash` and the
 * decrypted `directDeposit` block inside `payload_json`. Both are now stripped:
 * no admin page needs them, and the invoice page only reads `payload_json.total`.
 *
 * P1-15: budget spend is capped per BAM-month, not per receipt. Three $100
 * receipts in one month are $150 of reimbursement, not $300.
 *
 * P0-H: every `error` is inspected and surfaced. supabase-js does not throw.
 */
import { NextResponse } from 'next/server'
import { summarizeReceipts, reimbursementOnInvoice } from '@/lib/receipt-badge'
import { serviceClient } from '../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../lib/admin-auth'
import { provinceTaxRate } from '../../../../lib/invoice-payload'
import { rosterDrift, type RosterFacts } from '../../../../lib/refresh-invoice-snapshot'
import { SHORTFALL_WARN_BELOW_CAD, DEFAULT_POLICY } from '../../../../lib/policy'
import { REEVALUATE_THRESHOLD, consecutiveWarningStreak } from '../../../../lib/shortfall-warning'

/** $150/month, no rollover (Robin confirmed 2026-08-04). */
/**
 * Fallback only. The cap is a COHORT setting (`cohorts.reimbursement_max`), and this
 * file used to hardcode 150 in three places while selecting the real value for a
 * different tab and ignoring it. Every cohort happens to be 150 today, so the number
 * on screen was right by coincidence; the first cohort with a different cap would have
 * shown Robin a budget that was quietly wrong.
 */
const FALLBACK_CAP_CAD = DEFAULT_POLICY.reimbursementMax

/**
 * A cohort's reimbursement cap from an embedded relation, which PostgREST types as an
 * object on some selects and an array on others. Falls back rather than throwing: a
 * dashboard that renders nothing is worse than one that renders a documented default,
 * and the caller reports the fallback in `warnings`.
 */
function cohortCap(embedded: unknown): number {
  const row = Array.isArray(embedded) ? embedded[0] : embedded
  const raw = Number((row as { reimbursement_max?: unknown } | null | undefined)?.reimbursement_max)
  return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_CAP_CAD
}

function countConsecutiveLow(monthly: Record<string, number>, threshold: number): number {
  const months = Object.keys(monthly).sort()
  let maxStreak = 0, streak = 0
  for (const m of months) {
    if (monthly[m] < threshold) { streak++; maxStreak = Math.max(maxStreak, streak) }
    else streak = 0
  }
  return maxStreak
}

/** Banking + secret fields that must never reach the browser. */
const REDACTED_PAYLOAD_KEYS = ['directDeposit', 'hstNumber', 'hst_number'] as const

function redactPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) }
  for (const k of REDACTED_PAYLOAD_KEYS) delete out[k]
  return out
}

/**
 * Columns fetched on the embedded bams row for SERVER-SIDE work only, dropped before the
 * response is built. `prov` derives the tax rate for the invoice line editor. The rest are
 * compared against payload_json to compute `roster_drift`, and the browser only ever needs
 * the resulting field NAMES. The invoices table has no use for a BAM's address, email or
 * phone, so none of it travels.
 */
const SERVER_ONLY_BAM_KEYS = ['prov', 'email', 'phone', 'street', 'city', 'postal'] as const

/**
 * Splits the embedded bams row into what the browser gets and the province the caller
 * needs. supabase-js types an embedded one-to-one as an array.
 */
function stripBamProv(rel: unknown): { bams: unknown; prov: string | null } {
  const row = Array.isArray(rel) ? rel[0] : rel
  if (!row || typeof row !== 'object') return { bams: rel ?? null, prov: null }
  const rest = { ...(row as Record<string, unknown>) }
  const prov = rest.prov
  for (const k of SERVER_ONLY_BAM_KEYS) delete rest[k]
  return { bams: rest, prov: typeof prov === 'string' ? prov : null }
}

export async function GET(req: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const url = new URL(req.url)
  const table = url.searchParams.get('table')

  let admin
  try {
    admin = serviceClient()
  } catch {
    return NextResponse.json({ data: null, error: 'Service role key not configured' }, { status: 500 })
  }

  switch (table) {
    case 'bams': {
      // invite_token_hash removed: the roster UI never used it and shipping a
      // token hash to the browser has no upside. `has_invite` is enough to show
      // whether an invite is outstanding.
      const { data, error } = await admin.from('bams')
        .select('id, first_name, last_name, email, phone, status, bank_name, initials_resolved, invite_token_hash, school_id, cohort_id, is_test, street, city, prov, postal, cohorts(name)')
      if (error) return NextResponse.json({ data: null, error: error.message }, { status: 500 })

      const scrubbed = (data ?? []).map((row: Record<string, unknown>) => {
        const { invite_token_hash, ...rest } = row
        return { ...rest, has_invite: Boolean(invite_token_hash) }
      })
      return NextResponse.json({ data: scrubbed, error: null })
    }

    case 'receipts': {
      const { data, error } = await admin.from('receipts')
        .select('id, status, uploaded_at, cohort_id, bud_light_total_incl_tax, ambiguous_flags, decided_at, decision_reason, storage_key, storage_mime, storage_bytes, ocr_json, bams(first_name, last_name, is_test)')
        .order('uploaded_at', { ascending: false })
      if (error) return NextResponse.json({ data: null, error: error.message }, { status: 500 })
      return NextResponse.json({ data, error: null })
    }

    case 'invoices': {
      // `bams(prov)` is fetched for the tax rate only and is deleted from every
      // row before the response is built (see stripBamProv). The line editor
      // needs to preview tax at the SAME rate the server will apply; it does not
      // need the BAM's address.
      const { data: invoices, error } = await admin.from('invoices')
        .select('id, invoice_number, period, status, cohort_id, bam_id, released_at, revised_at, accepted_at, payload_json, bams(first_name, last_name, prov, email, phone, street, city, postal), cohorts(send_mode)')
        // Must include 'approved', 'paid' and 'void'. The filter used to be
        // ['draft','sent'], which hid an invoice the moment batch-approve set it to
        // 'approved' — and /api/admin/send-ap only accepts status='approved', so the
        // only invoices Robin could send were the only ones she could not see. It
        // also made the "N approved, not sent to AP" badge and the Retry AP button
        // unreachable, and left VOID visible only as in-session local state.
        .in('status', ['draft', 'approved', 'sent', 'paid', 'void'])
        .order('created_at', { ascending: false })
      if (error) return NextResponse.json({ data: null, error: error.message }, { status: 500 })
      if (!invoices) return NextResponse.json({ data: [], error: null })

      const bamIds = [...new Set((invoices as { bam_id: string }[]).map(i => i.bam_id))]
      const periods = [...new Set((invoices as { period: string }[]).map(i => i.period))]

      /*
       * All of a BAM's receipts for the month, not whichever row came back last.
       *
       * This map used to be assigned inside the loop, so a BAM with two receipts got a
       * badge describing one of them chosen by row order. Thirteen BAMs had more than one
       * September receipt and four had receipts in different states at once, which meant
       * an invoice could show a green badge while one of that student's receipts was still
       * waiting in the review queue. summarizeReceipts collapses them worst-state-first.
       */
      const receiptMap: Record<string, ReturnType<typeof summarizeReceipts>> = {}
      if (bamIds.length > 0 && periods.length > 0) {
        const { data: receipts, error: rErr } = await admin.from('receipts')
          .select('bam_id, period, status, bud_light_total_incl_tax')
          .in('bam_id', bamIds)
          .in('period', periods)
        if (rErr) return NextResponse.json({ data: null, error: rErr.message }, { status: 500 })
        const grouped: Record<string, Array<{ status: string; bud_light_total_incl_tax: number | null }>> = {}
        for (const r of (receipts ?? []) as { bam_id: string; period: string; status: string; bud_light_total_incl_tax: number | null }[]) {
          const key = `${r.bam_id}_${r.period}`
          ;(grouped[key] ??= []).push({ status: r.status, bud_light_total_incl_tax: r.bud_light_total_incl_tax })
        }
        for (const [key, rows] of Object.entries(grouped)) receiptMap[key] = summarizeReceipts(rows)
      }

      const enriched = (invoices as { bam_id: string; period: string; payload_json?: unknown; bams?: unknown; [k: string]: unknown }[]).map(inv => {
        const receipt = receiptMap[`${inv.bam_id}_${inv.period}`]
        const payload = (inv.payload_json ?? {}) as { subtotal?: unknown; tax?: unknown }
        // Whether this invoice charges tax is a fact about the invoice, taken
        // from what the generator already decided. The HST NUMBER itself is never
        // exposed (REDACTED_PAYLOAD_KEYS), only this boolean and the rate.
        const taxApplicable = Number(payload.tax ?? 0) > 0
        /*
         * WHICH FIELDS THIS INVOICE NO LONGER AGREES WITH THE ROSTER ON.
         *
         * Computed here, before redactPayload strips the payload, and returned as field
         * NAMES only -- the browser never needs the BAM's address to render a badge.
         *
         * The edit screens push a correction into open invoices when they save, and that
         * covers what people do. It does not cover onboarding ingest, a CSV import, a
         * fix- script or a hand edit in the dashboard. Comparing the two sides on load is
         * what turns "it probably propagated" into something the screen can answer.
         * Banking is not compared: it is encrypted and one decrypt per row is too much
         * for a list. batch-approve already refuses to send on a banking mismatch.
         */
        const rosterRow = (Array.isArray(inv.bams) ? inv.bams[0] : inv.bams) as RosterFacts | null
        const drift = (inv.status === 'draft' || inv.status === 'approved') && rosterRow
          ? rosterDrift(inv.payload_json as Record<string, unknown> | null, rosterRow)
          : []
        const { bams, prov } = stripBamProv(inv.bams)
        return {
          ...inv,
          bams,
          payload_json: redactPayload(inv.payload_json),
          receipt_status: receipt?.status ?? null,
          /*
           * What the invoice PAYS, read off the invoice, so the badge and the total beside
           * it cannot disagree. It used to be one receipt's amount: Royce
           * Barnes-Sutherland-Johnson submitted $137.15 and $20.36 and the badge said
           * $137.15 next to an invoice correctly paying the $150 cap.
           */
          receipt_total: reimbursementOnInvoice(inv.payload_json),
          /** Pre-cap spend, for the tooltip when it differs from what is paid. */
          receipt_spent: receipt?.spentCad ?? null,
          receipt_count: receipt?.count ?? 0,
          tax_applicable: taxApplicable,
          /** 0 when no tax applies, null when the province code is unknown (the
           *  server would refuse the edit rather than guess a rate). */
          tax_rate: taxApplicable ? provinceTaxRate(prov) : 0,
          /** Field names that disagree with the roster right now. Empty is the good case. */
          roster_drift: drift
        }
      })
      return NextResponse.json({ data: enriched, error: null })
    }

    case 'cohorts': {
      // salary_default / reimbursement_max / rollover_mode /
      // first_cohort_all_review decide how much money each BAM is paid, and none
      // of them was selected here, so no UI could show them and nobody could
      // check them. They are exposed read-only on /admin/cohorts.
      const { data: cohorts, error } = await admin.from('cohorts')
        .select('id, name, program_label, po_number, start_date, end_date, send_mode, bam_copy_mode, salary_default, reimbursement_max, rollover_mode, first_cohort_all_review')
      if (error) return NextResponse.json({ data: null, error: error.message }, { status: 500 })
      if (!cohorts) return NextResponse.json({ data: [], error: null })

      const withCounts = await Promise.all(cohorts.map(async (c: Record<string, unknown>) => {
        const { count, error: cErr } = await admin.from('bams')
          .select('id', { count: 'exact', head: true })
          .eq('cohort_id', c.id)
        if (cErr) console.error('[admin/data] cohort bam count failed:', cErr.message)
        return { ...c, bam_count: count ?? 0, bam_count_error: cErr ? cErr.message : null }
      }))
      return NextResponse.json({ data: withCounts, error: null })
    }

    case 'unmatched': {
      // Parked onboarding submissions. Banking fields are never stored here
      // (P0-3), and form_json_meta is already the stripped subset.
      const { data, error } = await admin.from('onboarding_submissions')
        .select('id, submitted_email, submitted_at, flag_reason, form_json_meta')
        .eq('status', 'unmatched')
        .order('submitted_at', { ascending: false })
      if (error) return NextResponse.json({ data: null, error: error.message }, { status: 500 })
      return NextResponse.json({ data, error: null })
    }

    // Support questions. /api/portal/support has always written these rows and
    // linked an admin notification to /admin/questions, but that page did not exist
    // and nothing read this table -- so email was the only way a question reached
    // anyone, and the route's own fallback comment ("Robin will see it in the
    // dashboard") was not true.
    case 'questions': {
      const { data, error } = await admin.from('portal_questions')
        // invoice_id (0035): set when the thread was opened from an invoice the BAM says
        // is wrong. The invoices screen reads it to show which payments are held.
        .select('id, question, submitted_at, notified_at, answered_at, answer, bam_id, invoice_id, portal_question_messages(id, author, body, created_at, attachment_key, attachment_mime, attachment_name, attachment_bytes), bams(first_name, last_name, email, school_id, cohorts(name))')
        .order('submitted_at', { ascending: false })
        .limit(200)
      if (error) return NextResponse.json({ data: null, error: error.message }, { status: 500 })
      return NextResponse.json({ data, error: null })
    }

    case 'audit': {
      const { data, error } = await admin.from('audit_log')
        .select('ts, actor_role, entity, entity_id, action, after_json')
        .order('ts', { ascending: false })
        .limit(200)
      if (error) return NextResponse.json({ data: null, error: error.message }, { status: 500 })
      return NextResponse.json({ data, error: null })
    }

    case 'dashboard': {
      const period = url.searchParams.get('period') ?? new Date().toISOString().slice(0, 7) + '-01'
      const [activeBams, pendingBams, receiptsSubmitted, reviewQueue, invoicesSent] = await Promise.all([
        admin.from('bams').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        // Test accounts sit in 'pending' for as long as somebody is rehearsing, and nobody has to
        // chase them to finish onboarding.
        admin.from('bams').select('id', { count: 'exact', head: true }).eq('status', 'pending').eq('is_test', false),
        admin.from('receipts').select('id', { count: 'exact', head: true }).eq('period', period),
        admin.from('receipts').select('id', { count: 'exact', head: true }).in('status', ['review', 'ocr_failed']),
        admin.from('invoices').select('id', { count: 'exact', head: true }).eq('status', 'sent').eq('period', period)
      ])

      const countErr = [activeBams, pendingBams, receiptsSubmitted, reviewQueue, invoicesSent]
        .map(r => r.error?.message).find(Boolean)
      if (countErr) return NextResponse.json({ data: null, error: countErr }, { status: 500 })

      // Receipt status breakdown for the period, grouped by BAM so the cap can
      // be applied once per BAM-month.
      const { data: periodReceipts, error: prErr } = await admin.from('receipts')
        .select('bam_id, status, bud_light_total_incl_tax')
        .eq('period', period)
      if (prErr) return NextResponse.json({ data: null, error: prErr.message }, { status: 500 })

      const receiptBreakdown: Record<string, { count: number; total: number }> = {}
      const eligiblePerBam: Record<string, number> = {}
      for (const r of (periodReceipts ?? []) as { bam_id: string; status: string; bud_light_total_incl_tax: number | null }[]) {
        if (!receiptBreakdown[r.status]) receiptBreakdown[r.status] = { count: 0, total: 0 }
        receiptBreakdown[r.status].count++
        const amt = r.bud_light_total_incl_tax ?? 0
        // Raw receipt total for this status. NOT capped: this is "what was
        // submitted", and capping here made the number mean nothing.
        receiptBreakdown[r.status].total += amt
        if (r.status === 'auto_pass' || r.status === 'approved') {
          eligiblePerBam[r.bam_id] = (eligiblePerBam[r.bam_id] ?? 0) + amt
        }
      }

      // P1-15: cap once per BAM for the month, at THAT BAM's cohort cap.
      const { data: capBams, error: capErr } = await admin.from('bams')
        .select('id, status, cohorts(reimbursement_max)')
        .eq('status', 'active')
      const capWarnings: string[] = []
      if (capErr) {
        console.error('[admin/data] cohort cap read failed:', capErr.message)
        capWarnings.push(`Cohort reimbursement caps are unreadable (${capErr.message}). Budget figures use $${FALLBACK_CAP_CAD.toFixed(2)} per BAM, which may not match your cohorts.`)
      }
      const capFor: Record<string, number> = {}
      let capSum = 0
      for (const b of (capBams ?? []) as unknown as { id: string; cohorts?: unknown }[]) {
        const cap = cohortCap(b.cohorts)
        capFor[b.id] = cap
        capSum += cap
      }

      const receiptDerivedSpend = Object.entries(eligiblePerBam)
        .reduce((sum, [bamId, v]) => sum + Math.min(v, capFor[bamId] ?? FALLBACK_CAP_CAD), 0)

      // Truth source for money is the ledger (ENGINEERING-RULES 7.2). Use it when
      // it has rows for this period; otherwise say so explicitly.
      //
      // A ledger query failure does NOT fail the whole endpoint: the KPIs above do
      // not depend on it, and blanking the entire dashboard over one unavailable
      // table hides more than it reveals. It IS reported in `warnings` and shown in
      // the UI, so it can never pass as "no spend yet".
      const warnings: string[] = [...capWarnings]

      const { data: periodLedger, error: plErr } = await admin.from('reimbursement_ledger')
        .select('paid_cad')
        .eq('period', period)
      if (plErr) {
        console.error('[admin/data] period ledger query failed:', plErr.message)
        warnings.push(`Reimbursement ledger is unreadable (${plErr.message}). Budget figures are estimated from receipts.`)
      }

      const ledgerRows = (periodLedger ?? []) as { paid_cad: number | null }[]
      const ledgerSpend = ledgerRows.reduce((sum, r) => sum + (r.paid_cad ?? 0), 0)
      const useLedger = !plErr && ledgerRows.length > 0

      const totalReimbSpent = Math.round((useLedger ? ledgerSpend : receiptDerivedSpend) * 100) / 100
      const budgetSource: 'ledger' | 'receipts_capped' = useLedger ? 'ledger' : 'receipts_capped'

      const nActive = activeBams.count ?? 0
      // Sum of each active BAM's own cohort cap, not headcount times a constant.
      const budgetCap = capSum > 0 ? capSum : nActive * FALLBACK_CAP_CAD
      const budgetPct = budgetCap > 0 ? Math.round((totalReimbSpent / budgetCap) * 100) : 0

      // Monthly chart data
      const { data: monthlyInvoices, error: miErr } = await admin.from('invoices')
        .select('period, status')
        .in('status', ['sent', 'draft'])
        .order('period', { ascending: true })
      if (miErr) return NextResponse.json({ data: null, error: miErr.message }, { status: 500 })

      const { data: monthlyLedger, error: mlErr } = await admin.from('reimbursement_ledger')
        .select('period, paid_cad')
        .order('period', { ascending: true })
      if (mlErr) {
        // The old code discarded this error, which is why the "Monthly
        // reimbursement" chart could render as a confident empty chart while the
        // query was in fact failing.
        console.error('[admin/data] monthly ledger query failed:', mlErr.message)
        warnings.push(`Monthly reimbursement history is unreadable (${mlErr.message}).`)
      }

      const invoicesByMonth: Record<string, number> = {}
      const reimbByMonth: Record<string, number> = {}
      for (const inv of (monthlyInvoices ?? []) as { period: string }[]) {
        const m = inv.period.slice(0, 7)
        invoicesByMonth[m] = (invoicesByMonth[m] ?? 0) + 1
      }
      for (const entry of (monthlyLedger ?? []) as { period: string; paid_cad: number | null }[]) {
        const m = entry.period.slice(0, 7)
        reimbByMonth[m] = Math.round(((reimbByMonth[m] ?? 0) + (entry.paid_cad ?? 0)) * 100) / 100
      }

      return NextResponse.json({
        data: {
          activeBams: nActive,
          pendingBams: pendingBams.count ?? 0,
          receiptsSubmitted: receiptsSubmitted.count ?? 0,
          reviewQueue: reviewQueue.count ?? 0,
          invoicesSent: invoicesSent.count ?? 0,
          receiptBreakdown,
          budgetCap,
          budgetSpent: totalReimbSpent,
          budgetPct,
          budgetSource,
          invoicesByMonth,
          reimbByMonth,
          warnings
        },
        error: null
      })
    }

    case 'notifications': {
      const unreadOnly = url.searchParams.get('unread') === 'true'
      let q = admin.from('admin_notifications')
        // The BAM's name, joined here rather than baked into each notification's title at
        // creation time. "Shortfall detected / $58.45 spent" told Robin an amount and not who it
        // was about, and there are seven places that create notifications. One join fixes all of
        // them, and it stays correct if somebody's name is later corrected on the roster.
        .select('id, type, title, body, link, read, created_at, bam_id, bams(first_name, last_name, school_id)')
        .order('created_at', { ascending: false })
        .limit(50)
      if (unreadOnly) q = q.eq('read', false)
      const { data, error } = await q
      if (error) return NextResponse.json({ data: null, unreadCount: 0, error: error.message }, { status: 500 })

      const { count: unreadCount, error: cErr } = await admin.from('admin_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('read', false)
      if (cErr) return NextResponse.json({ data, unreadCount: 0, error: cErr.message }, { status: 500 })

      return NextResponse.json({ data, unreadCount: unreadCount ?? 0, error: null })
    }

    case 'bam_spending': {
      const { data: bams, error: bErr } = await admin.from('bams')
        .select('id, cohort_id, first_name, last_name, email, status, cohorts(name, start_date, end_date, reimbursement_max)')
        .eq('status', 'active')
        .eq('is_test', false)
      if (bErr) return NextResponse.json({ data: null, error: bErr.message }, { status: 500 })
      if (!bams || bams.length === 0) return NextResponse.json({ data: [], error: null })

      const bamIds = (bams as { id: string }[]).map(b => b.id)
      const { data: receipts, error: rErr } = await admin.from('receipts')
        .select('bam_id, period, bud_light_total_incl_tax, status')
        .in('bam_id', bamIds)
        .in('status', ['auto_pass', 'approved'])
      if (rErr) return NextResponse.json({ data: null, error: rErr.message }, { status: 500 })

      // Raw submitted amount per BAM-month (uncapped) so the UI can show both
      // "submitted" and "eligible".
      const spendMap: Record<string, Record<string, number>> = {}
      for (const r of (receipts ?? []) as { bam_id: string; period: string; bud_light_total_incl_tax: number | null }[]) {
        const month = r.period.slice(0, 7)
        if (!spendMap[r.bam_id]) spendMap[r.bam_id] = {}
        spendMap[r.bam_id][month] = (spendMap[r.bam_id][month] ?? 0) + (r.bud_light_total_incl_tax ?? 0)
      }

      // Shortfall warnings are supplementary. If the table is unavailable the
      // spending table is still useful, so this degrades to an explicit warning
      // rather than blanking the section. It is NOT swallowed.
      const dataWarnings: string[] = []
      const { data: warnings, error: wErr } = await admin.from('bam_warnings')
        .select('bam_id, warning_number, sent_at, period')
        .in('bam_id', bamIds)
      if (wErr) {
        console.error('[admin/data] bam_warnings query failed:', wErr.message)
        dataWarnings.push(`Shortfall warning history is unreadable (${wErr.message}). Warning counts below show 0 regardless of reality.`)
      }

      const warningMap: Record<string, { count: number; sent: number; periods: string[] }> = {}
      for (const w of (warnings ?? []) as { bam_id: string; warning_number: number; sent_at: string | null; period: string }[]) {
        if (!warningMap[w.bam_id]) warningMap[w.bam_id] = { count: 0, sent: 0, periods: [] }
        warningMap[w.bam_id].count = Math.max(warningMap[w.bam_id].count, w.warning_number)
        if (w.sent_at) warningMap[w.bam_id].sent++
        warningMap[w.bam_id].periods.push(w.period)
      }

      // "Low" now means the SAME number that triggers a warning email. It was 130
      // here and 75 in lib/policy.ts, so a BAM who spent $100 was shown to Robin as
      // low while no warning was ever sent to them. One threshold, one source.
      const LOW_THRESHOLD = SHORTFALL_WARN_BELOW_CAD
      const result = (bams as unknown as { id: string; first_name: string; last_name: string; email: string; cohort_id: string; cohorts?: { name: string; reimbursement_max?: number | null } | null }[]).map(b => {
        const monthly = spendMap[b.id] ?? {}
        const months = Object.keys(monthly).sort()
        const cap = cohortCap(b.cohorts)
        // P1-15: cap per month before totalling, at this BAM's own cohort cap.
        const eligibleTotal = months.reduce((sum, m) => sum + Math.min(monthly[m], cap), 0)
        const avgMonthly = months.length > 0 ? eligibleTotal / months.length : 0
        const lowMonths = Object.entries(monthly).filter(([, v]) => v < LOW_THRESHOLD).length
        const consecutiveLow = countConsecutiveLow(monthly, LOW_THRESHOLD)
        const warnInfo = warningMap[b.id] ?? { count: 0, sent: 0, periods: [] }
        // Consecutive, per Robin over Teams. This read `warnInfo.count >= 2`, which
        // flagged two shortfalls in different halves of the year as if they had been
        // back to back. The streak was already being computed and thrown away.
        const warnedPeriods = warnInfo.periods.map(p => String(p).slice(0, 8) + '01')
        const latestWarned = [...warnedPeriods].sort().pop()
        const warningStreak = latestWarned ? consecutiveWarningStreak(warnedPeriods, latestWarned) : 0
        return {
          bam_id: b.id,
          cohort_id: b.cohort_id,
          name: `${b.first_name} ${b.last_name}`,
          email: b.email,
          cohort: b.cohorts?.name ?? 'Unassigned',
          monthly,
          totalSpent: Math.round(eligibleTotal * 100) / 100,
          avgMonthly: Math.round(avgMonthly * 100) / 100,
          lowMonths,
          consecutiveLow,
          isLowPerformer: consecutiveLow >= 3,
          warningCount: warnInfo.count,
          warningsSent: warnInfo.sent,
          warningPeriods: warnInfo.periods,
          warningStreak,
          monthlyCap: cap,
          needsReevaluation: warningStreak >= REEVALUATE_THRESHOLD,
        }
      })

      return NextResponse.json({ data: result, warnings: dataWarnings, error: null })
    }

    default:
      return NextResponse.json({ error: 'Invalid table parameter' }, { status: 400 })
  }
}
