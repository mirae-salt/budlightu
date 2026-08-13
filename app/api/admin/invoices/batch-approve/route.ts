/**
 * POST /api/admin/invoices/batch-approve  { invoice_ids }
 * Program admin's touchpoint 2 action. Runs render → 3-way send for every draft
 * invoice in the batch. Respects cohort.send_mode + bam_copy_mode; sends only
 * to targets whose mode allows it. Live send requires the super-admin toggle
 * elsewhere; this endpoint does not flip send_mode itself.
 *
 * AUDIT-2026-08-07 (P1-2) fixes:
 *  - It wrote status:'approved' and approved_at. 'approved' violated the CHECK
 *    ('draft','sent','paid','void') and approved_at existed in no migration, so
 *    this endpoint ALWAYS 500'd — touchpoint 2 did not work at all. Both are
 *    added in 0018_invoice_engine_fixes.sql.
 *  - The "atomically mark all approved before external sends" comment was wrong
 *    in the dangerous direction: it flipped every invoice's status BEFORE any
 *    send, then treated per-send failures as non-fatal, leaving a batch marked
 *    approved with nothing sent and no safe retry. Status is now flipped per
 *    invoice, only AFTER that invoice's AP send succeeds, and only from 'draft'
 *    (never downgrading an invoice the send just marked 'sent').
 *  - P0-D: each invoice is reconciled against reimbursement_ledger.paid_cad
 *    before it is sent.
 *  - Partial failure is reported per invoice and is safe to re-run: sends that
 *    succeeded are blocked by the invoice_sends guard, sends that failed are
 *    retryable.
 *
 * CRITIC GATE 2026-08-07 · F1: this endpoint was still inoperable after the P1-2
 * fix, for a different reason. All three downstream handlers required
 * `invoices.pdf_key` and NOTHING in the codebase ever wrote it, so `ap.ok` was
 * never true, status never became 'approved', nothing was archived, and BAM
 * copies had no attachment. Robin would have selected 58 drafts and collected 58
 * failures. The PDF is now rendered and archived once per invoice here, via the
 * shared lib/invoice-pdf.ts path, BEFORE the three sends — so all three attach
 * the same bytes and pdf_key is written exactly once.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { handler as sendAp }      from '../../../../../supabase/functions/sendApEmail/index'
import { handler as sendBamCopy } from '../../../../../supabase/functions/sendBamCopy/index'
/*
 * NO SHAREPOINT ARCHIVE STEP. Mirae, 2026-08-13: "sharepoint 안쓸거야".
 *
 * It was a third send target here and it never once succeeded: Salt IT never issued the Graph
 * credentials, so it returned "graph auth failed" and batch approve counted a fully working
 * invoice as failed. On 9/17 that would have been 58 of 58.
 *
 * The invoice PDF is archived: ensureInvoicePdf below writes it to the Supabase `invoices`
 * bucket and records `pdf_key`, which is the copy AP receives and the copy /admin/invoices
 * offers as Download and Download ZIP. SharePoint was a second filing location, not the
 * archive.
 *
 * Deleted rather than left dormant behind a flag, which is what was done to the Microsoft
 * Graph email implementation for the same reason (see sendApEmail's header). `git log` has it
 * if it is ever wanted back.
 */
import { lookupReimbursement, payloadLedgerMismatch, undecidedReceiptsProblem } from '../../../../../lib/invoice-ledger'
import type { InvoicePayload } from '../../../../../lib/invoice-payload'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import { ensureInvoicePdf } from '../../../../../lib/invoice-pdf'
import { invoicePdfFilename } from '../../../../../lib/invoice-numbering'

type StepResult = { ok: boolean; error?: string; skipped?: boolean }

interface BatchItemResult {
  id: string
  invoice_number?: string
  blocked?: string
  approved?: boolean
  pdf_key?: string | null
  warnings?: string[]
  ap?: StepResult
  bam?: StepResult
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const invoiceIds: string[] = body.invoice_ids ?? []
  if (!invoiceIds.length) return NextResponse.json({ ok: false, message: 'invoice_ids required' }, { status: 400 })

  // Touchpoint 2 is an admin action. P0-A: role from app_metadata only.
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const admin = serviceClient()

  const { data: invoices, error: invErr } = await admin.from('invoices')
    .select('id, cohort_id, bam_id, period, invoice_number, status, payload_json, pdf_key, bams(first_name, last_name)')
    .in('id', invoiceIds)
    .eq('status', 'draft')
  if (invErr) return NextResponse.json({ ok: false, message: `invoices read failed: ${invErr.message}` }, { status: 500 })
  if (!invoices?.length) return NextResponse.json({ ok: true, processed: 0, results: [] })

  const cohortIds = [...new Set(invoices.map(i => i.cohort_id))]
  const { data: cohorts, error: cohortErr } = await admin.from('cohorts').select('*').in('id', cohortIds)
  if (cohortErr) return NextResponse.json({ ok: false, message: `cohorts read failed: ${cohortErr.message}` }, { status: 500 })
  const cohortMap = new Map((cohorts ?? []).map(c => [c.id, c]))

  for (const c of cohortMap.values()) {
    if (!c.po_number) {
      return NextResponse.json({ ok: false, message: `HARD BLOCK · cohort ${c.name} has no po_number` }, { status: 412 })
    }
  }

  const results: BatchItemResult[] = []

  for (const inv of invoices) {
    const cohort = cohortMap.get(inv.cohort_id)
    if (!cohort) {
      results.push({ id: inv.id, invoice_number: inv.invoice_number, blocked: 'cohort not found' })
      continue
    }

    // P0-D: never send a document that disagrees with the ledger.
    const ledger = await lookupReimbursement(admin, inv.bam_id, inv.cohort_id, inv.period)
    if (!ledger.ok) {
      results.push({ id: inv.id, invoice_number: inv.invoice_number, blocked: ledger.error })
      continue
    }
    const mismatch = payloadLedgerMismatch((inv.payload_json as unknown as InvoicePayload | null)?.lines, ledger.paidCad)
    if (mismatch) {
      results.push({ id: inv.id, invoice_number: inv.invoice_number, blocked: mismatch })
      continue
    }
    // The document agreeing with the ledger is not enough if the ledger itself is not finished.
    // A receipt still in Robin's queue is money this invoice does not carry, and AP treats what
    // it receives as final.
    const undecided = await undecidedReceiptsProblem(admin, inv.bam_id, inv.period)
    if (undecided) {
      results.push({ id: inv.id, invoice_number: inv.invoice_number, blocked: undecided })
      continue
    }

    // F1: render + archive ONCE, before any send. This is what writes pdf_key.
    // A render failure blocks this invoice only (AP requires 1 PDF per email —
    // an email with no attachment is worse than a reported failure).
    // supabase-js types an embedded one-to-one as an array; take the first row.
    const bamRel = (inv as unknown as {
      bams?: { first_name?: string | null; last_name?: string | null } | Array<{ first_name?: string | null; last_name?: string | null }> | null
    }).bams
    const bamRow = Array.isArray(bamRel) ? bamRel[0] : bamRel
    const filename = invoicePdfFilename(
      bamRow?.first_name ?? '',
      bamRow?.last_name ?? '',
      new Date(inv.period),
      inv.invoice_number
    )
    const pdf = await ensureInvoicePdf(admin, {
      id: inv.id,
      period: inv.period,
      invoice_number: inv.invoice_number,
      pdf_key: inv.pdf_key,
      payload_json: inv.payload_json
    }, filename)
    if (!pdf.ok) {
      results.push({ id: inv.id, invoice_number: inv.invoice_number, blocked: pdf.error })
      continue
    }

    const ap = await step(() => sendAp({ invoice_id: inv.id, mode: cohort.send_mode }))
    const bam = cohort.bam_copy_mode === 'off'
      ? { ok: true, skipped: true }
      : await step(() => sendBamCopy({ invoice_id: inv.id, mode: cohort.bam_copy_mode }))

    // Approval is recorded only after the AP send actually succeeded, and only
    // while the row is still 'draft' (a live send already set it to 'sent').
    //
    // AND ONLY WHEN THE COHORT IS LIVE.
    //
    // A dryrun send returns ok:true without emailing anything (sendApEmail:139). This block then
    // moved the row to 'approved', and the select at the top of this route only picks up 'draft', so
    // re-running after flipping the cohort to live returned processed: 0. Those invoices could then
    // only be sent through app/api/admin/send-ap, a different file with its own body builder and CC
    // assembly, which means the three invoices somebody rehearsed were the three that went out
    // through untested code. A fire drill that marks everyone as already evacuated.
    //
    // Leaving them 'draft' makes the rehearsal repeatable through the identical entry point, which is
    // the whole point of a rehearsal.
    const isLive = cohort.send_mode === 'live'
    let approved = false
    let approveError: string | undefined
    if (ap.ok && isLive) {
      const { data: updated, error: updErr } = await admin.from('invoices')
        .update({ status: 'approved', approved_at: new Date().toISOString() })
        .eq('id', inv.id)
        .eq('status', 'draft')
        .select('id')
      if (updErr) approveError = `approve write failed: ${updErr.message}`
      else approved = (updated ?? []).length > 0
    }

    results.push({
      id: inv.id,
      invoice_number: inv.invoice_number,
      approved,
      // `approved: false` on its own reads as a failure. This says WHY it is false: the cohort is
      // not live, so nothing was emailed and the row was deliberately left in 'draft' so the same
      // run can be repeated for real.
      ...(isLive ? {} : { rehearsal: true, mode: cohort.send_mode }),
      pdf_key: pdf.pdfKey,
      ...(pdf.warning ? { warnings: [pdf.warning] } : {}),
      ap: approveError ? { ok: ap.ok, error: [ap.error, approveError].filter(Boolean).join(' | ') } : ap,
      bam
    })
  }

  // A SKIPPED step is not a failed one: the BAM copy is off by cohort setting, not broken.
  const failures = results.filter(r =>
    r.blocked ||
    !r.ap?.ok ||
    (!r.bam?.skipped && !r.bam?.ok)
  )
  const rehearsed = results.filter(r => (r as { rehearsal?: boolean }).rehearsal).length
  return NextResponse.json({
    ok: failures.length === 0,
    processed: results.length,
    failures: failures.length,
    // How many were left in 'draft' on purpose, so the caller can say so instead of implying the run
    // finished the job. Zero on a live cohort.
    rehearsed,
    retry_safe: true,
    results
  })
}

/** Normalizes an Edge Function handler result and never throws. */
async function step(fn: () => Promise<unknown>): Promise<StepResult> {
  try {
    const r = (await fn()) as { ok?: boolean; error?: string; skipped?: boolean } | undefined
    return { ok: Boolean(r?.ok), error: r?.error, skipped: r?.skipped }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
