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
import { sendEligibleAt, windowStartedAt } from '../../../../../lib/business-days'
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
    .select('id, cohort_id, bam_id, period, invoice_number, status, released_at, revised_at, accepted_at, payload_json, pdf_key, bams(first_name, last_name, status)')
    .in('id', invoiceIds)
    .eq('status', 'draft')
  if (invErr) return NextResponse.json({ ok: false, message: `invoices read failed: ${invErr.message}` }, { status: 500 })
  if (!invoices?.length) return NextResponse.json({ ok: true, processed: 0, results: [] })

  /*
   * Which of these invoices the BAM has an unanswered question open on.
   *
   * An objection is a portal_questions thread pointing at the invoice (0035), so
   * "unanswered" is the same condition as "still owes this student a reply" and there is
   * no second state to keep in step.
   *
   * Read once for the batch rather than per invoice: 58 invoices would otherwise be 58
   * round trips inside the send loop, and a query that runs per iteration is a query
   * somebody eventually moves outside the guard by accident.
   */
  const { data: allThreads, error: dispErr } = await admin.from('portal_questions')
    .select('invoice_id, answered_at')
    .in('invoice_id', invoices.map(i => i.id))
  if (dispErr) {
    // Fail CLOSED. Not knowing whether a BAM objected is a worse reason to send money
    // than knowing they did.
    return NextResponse.json(
      { ok: false, message: `could not check for open objections: ${dispErr.message} -- refusing to send` },
      { status: 500 }
    )
  }
  const disputed = new Set((allThreads ?? []).filter(d => !d.answered_at).map(d => d.invoice_id))


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

    // supabase-js types an embedded one-to-one as an array; take the first row.
    // Pulled up here (rather than just before the PDF filename below, where it used
    // to live) so the status check below and the filename can both use it.
    const bamRel = (inv as unknown as {
      bams?: { first_name?: string | null; last_name?: string | null; status?: string | null }
        | Array<{ first_name?: string | null; last_name?: string | null; status?: string | null }> | null
    }).bams
    const bamRow = Array.isArray(bamRel) ? bamRel[0] : bamRel

    // A BAM archived after this invoice was seeded is not on the roster this
    // batch is meant to pay. Nothing else in this route checks bam status --
    // scheduler-generate refuses to CREATE one for a non-active BAM, but a
    // draft seeded on the 1st and archived before the 17th survives, sits in
    // the list with everyone else's, and this was the only thing standing
    // between checking its box and it going to AP. Mirae, 2026-09-15.
    if (bamRow?.status !== 'active') {
      // Fail CLOSED, not just on 'archived'/'pending': a missing join (a bam row
      // deleted outright, not merely archived) reads the same as bamRow being
      // undefined, and that is a worse reason to send money than a status we can
      // name. Nothing here should require IDENTIFYING the problem to block it.
      results.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        blocked: bamRow?.status
          ? `BAM is ${bamRow.status}, not active -- void this invoice instead of approving it`
          : 'Could not confirm this BAM is active (no matching roster row) -- refusing to send'
      })
      continue
    }

    /*
     * THE BAM'S 24-HOUR OBJECTION WINDOW (2026-09-16, Legal).
     *
     * Three separate refusals, each named, because "cannot send" with no reason is what
     * sends Robin to ask Mirae. All of them fail closed: an invoice that has not been
     * shown to the person being paid does not go to AP, and neither does one they have
     * actively objected to.
     *
     * This gate lives here rather than in /api/admin/send-ap because THIS is the first
     * send. send-ap refuses anything that is not already 'approved', and an invoice only
     * becomes 'approved' at the bottom of this loop, after its AP email has gone out.
     */
    if (disputed.has(inv.id)) {
      results.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        blocked: 'this BAM raised an objection that is still open -- resolve it before sending'
      })
      continue
    }
    // From release only. A correction does not restart the clock: the send day is fixed,
    // so corrections happen inside the first window rather than moving it (0036).
    const windowStart = windowStartedAt(inv.released_at)
    if (!windowStart) {
      results.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        blocked: 'not released to the BAM yet -- release it first, then send once their 24 hours are up'
      })
      continue
    }
    /*
     * The WAIT is waived when the cohort is not live. Nothing else is.
     *
     * A dryrun cohort emails nobody, so there is no payment for the window to protect,
     * and making a rehearsal take a real day means the send half of this flow never gets
     * rehearsed at all. Releasing is still required and an open objection still blocks,
     * because those are the parts worth practising and both are testable in seconds.
     *
     * Keyed off the cohort's own send_mode rather than NODE_ENV: the live cohort must
     * keep its window even when someone is testing on the same deployment.
     */
    const eligibleAt = sendEligibleAt(windowStart)
    /*
     * The BAM's own "this is right" waives the WAIT and nothing else (0037).
     *
     * It is an accelerator, not a requirement: silence through the window is still how an
     * invoice goes out, flagged or not (Mirae, 2026-09-16: "if they dont and 24h passed it
     * will just automatically confirmed approved"). What it buys is the case where someone
     * raised a problem, it got fixed, and they are happy: the invoice can go now instead
     * of waiting out a clock that nobody is using any more.
     *
     * An unanswered question still blocks regardless, because that one is us owing them a
     * reply rather than them owing us one.
     */
    if (cohort.send_mode === 'live' && !inv.accepted_at && Date.now() < eligibleAt.getTime()) {
      results.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        blocked: `the BAM's 24 hours are not up yet -- this one can go out after ${eligibleAt.toISOString()}`
      })
      continue
    }

    // THE BANKING IN THE PDF MUST STILL BE THE BAM'S BANKING, RIGHT NOW.
    //
    // generateInvoicePayload bakes institution/transit/account into payload_json once,
    // at creation time. banking-requests/decide swaps that field when a correction is
    // approved on an invoice that is still draft/approved, but that is a courtesy, not
    // a guarantee -- it can fail, and nothing stops a future change path from writing
    // banking some other way. This re-decrypts the BAM's CURRENT banking and refuses to
    // send if it disagrees with what is already sitting in the payload, no matter how
    // the two came to differ. Mirae, 2026-09-15, after Lea Major/Emma Romans surfaced
    // how many separate paths can touch either side of this comparison.
    const bankingRes = await admin.rpc('decrypt_bam_banking', { p_bam_id: inv.bam_id })
    if (bankingRes.error) {
      results.push({ id: inv.id, invoice_number: inv.invoice_number, blocked: `could not confirm current banking: ${bankingRes.error.message}` })
      continue
    }
    const currentBanking = (Array.isArray(bankingRes.data) ? bankingRes.data[0] : bankingRes.data) as
      { institution_no?: string | null; transit_no?: string | null; account_no?: string | null } | null
    const payloadDD = ((inv.payload_json as unknown as InvoicePayload | null)?.directDeposit) ?? null
    const bankingMatches =
      currentBanking?.institution_no && currentBanking?.transit_no && currentBanking?.account_no &&
      payloadDD?.institutionNumber === currentBanking.institution_no &&
      payloadDD?.transitNumber === currentBanking.transit_no &&
      payloadDD?.accountNumber === currentBanking.account_no
    if (!bankingMatches) {
      results.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        blocked: 'This invoice\'s banking does not match what is currently on file for this BAM -- regenerate it before approving.'
      })
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
    // bamRow was pulled from the same embed above, for the status check.
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
