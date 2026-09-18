/**
 * POST /api/admin/invoices/release  { invoice_ids }
 *
 * Publishes finished invoices to the BAMs they belong to and starts their 24-hour
 * objection window. Legal asked for this on 2026-09-16: the person being paid gets an
 * interval to say "that is wrong" before the payment leaves, and silence inside that
 * interval counts as acceptance.
 *
 * WHY THIS IS A BUTTON AND NOT A DATE
 * -----------------------------------
 * The cadence already separates the 16th (audit, when Robin clears the flagged receipts)
 * from the 17th (generate), specifically so Robin has a day to review. Publishing on a
 * fixed clock would mean generating earlier and taking that day back. An admin pressing
 * this says "this figure is final" at a moment they choose, which is also the assertion
 * Legal actually wants recorded.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not change `status`. The invoice stays `draft` until batch-approve sends it to
 * AP, so releasing cannot skip a step or be mistaken for one. The only thing that moves
 * is `released_at`, and batch-approve refuses to send until that stamp is old enough and
 * no objection is open.
 *
 * Re-releasing is refused rather than ignored. Re-stamping would silently restart
 * somebody's 24 hours, and the one case where that matters is the case where the figure
 * changed under them.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireAdmin, denied } from '../../../../../lib/admin-auth'
import { sendEligibleAt } from '../../../../../lib/business-days'
import { notifyBam } from '../../../../../lib/notify-bam'
import { sendEmail } from '../../../../../lib/send-email'
import { invoiceReleaseEmail } from '../../../../../lib/invoice-review-email'
import { ensureInvoicePdf } from '../../../../../lib/invoice-pdf'

// Renders a PDF and emails one BAM per invoice, in sequence. Same reason as batch-approve:
// a release cut short leaves half the cohort notified and half not.
export const maxDuration = 300

/**
 * The deadline as a person reads it.
 *
 * Eastern, and it says so. The gate itself is UTC arithmetic (lib/business-days), but a
 * BAM in Vancouver reading "13:00" with no zone will assume their own and think they have
 * three hours less than they do. Display-only, so using the platform's timezone data here
 * costs nothing that lib/deadline.ts was protecting against.
 */
function deadlineLabel(d: Date): string {
  return d.toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  }) + ' Eastern'
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return denied(auth)

  const body = await req.json().catch(() => ({}))
  const invoiceIds: string[] = Array.isArray(body?.invoice_ids) ? body.invoice_ids : []
  if (!invoiceIds.length) {
    return NextResponse.json({ ok: false, message: 'invoice_ids required' }, { status: 400 })
  }

  const admin = serviceClient()

  const { data: invoices, error: invErr } = await admin.from('invoices')
    .select('id, bam_id, cohort_id, period, invoice_number, status, released_at, pdf_key, payload_json, bams(first_name, email), cohorts(send_mode)')
    .in('id', invoiceIds)
  if (invErr) {
    return NextResponse.json({ ok: false, message: `invoices read failed: ${invErr.message}` }, { status: 500 })
  }
  if (!invoices?.length) return NextResponse.json({ ok: true, released: 0, results: [] })

  const now = new Date()
  const results: Array<{ id: string; invoice_number: string | null; released?: true; blocked?: string }> = []
  /** Released fine, email held because the cohort is rehearsing. Counted, not flagged. */
  let dryrunSkipped = 0

  for (const inv of invoices) {
    if (inv.status !== 'draft') {
      results.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        blocked: `invoice is ${inv.status} -- only a draft can be released for review`
      })
      continue
    }
    if (inv.released_at) {
      results.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        blocked: `already released at ${inv.released_at} -- releasing again would restart their 24 hours`
      })
      continue
    }

    // Read back: a write that matched no row is not a release, and the BAM would be
    // told to review something whose clock never started.
    const { data: updated, error: upErr } = await admin.from('invoices')
      .update({ released_at: now.toISOString(), released_by: auth.devBypass ? null : auth.userId })
      .eq('id', inv.id)
      .eq('status', 'draft')
      .is('released_at', null)
      .select('id, released_at')
    if (upErr) {
      results.push({ id: inv.id, invoice_number: inv.invoice_number, blocked: `release failed: ${upErr.message}` })
      continue
    }
    if (!updated || updated.length !== 1) {
      results.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        blocked: 'release matched no row (someone else released or changed it just now)'
      })
      continue
    }

    /*
     * Telling them is the point of the whole feature, so a notification failure is
     * reported rather than swallowed. The stamp stays: the window HAS started, and
     * pretending otherwise would be a second wrong thing on top of the first.
     */
    const notified = await notifyBam({
      bam_id: inv.bam_id,
      type: 'invoice_review',
      title: 'Your invoice is ready to check',
      body: `Invoice ${inv.invoice_number ?? ''} is ready. Please look it over. `
        + `If nothing comes back from you by ${deadlineLabel(sendEligibleAt(now))}, we send it as it stands.`,
      link: '/portal/invoices',
      period: inv.period
    })

    /*
     * The email, with the invoice attached.
     *
     * The bell alone is not enough for something on a 24-hour clock: a BAM who does not
     * open the portal that day would learn about their window after it closed, and the
     * whole point is that they had a real chance to object. The PDF goes with it for the
     * same reason the portal shows it at release. Nobody can review a number they were
     * not given.
     *
     * ensureInvoicePdf is the shared render/archive path that batch-approve uses later,
     * so the document a BAM reviews is byte-identical to the one AP receives rather than
     * an independent re-render that could differ.
     */
    let emailNote: string | null = null
    const bamRel = (inv as unknown as {
      bams?: { first_name?: string | null; email?: string | null } | Array<{ first_name?: string | null; email?: string | null }> | null
    }).bams
    const bam = Array.isArray(bamRel) ? bamRel[0] : bamRel

    const cohortRel = (inv as unknown as {
      cohorts?: { send_mode?: string | null } | Array<{ send_mode?: string | null }> | null
    }).cohorts
    const sendMode = (Array.isArray(cohortRel) ? cohortRel[0] : cohortRel)?.send_mode ?? 'dryrun'

    if (sendMode !== 'live') {
      /*
       * A dryrun cohort emails nobody, the same way sendApEmail treats it.
       *
       * This route ignored send_mode at first, which would have put a real email in 58
       * students' inboxes the first time anyone rehearsed a release. The stamp and the
       * portal notification still happen, so the flow can be exercised end to end; only
       * the outbound mail is held.
       *
       * Unknown or missing mode reads as dryrun, not live: not knowing whether we are
       * rehearsing is a bad reason to email real people.
       *
       * DELIBERATELY NOT A PER-INVOICE PROBLEM. It was reported in the same field as a
       * failure, so every rehearsal release came back as a red "that did not go through"
       * on a release that had worked perfectly. A warning that fires every single time in
       * the test cohort is a warning nobody reads by the time it means something. The
       * response says it once, for the batch, instead.
       */
      dryrunSkipped++
    } else if (!bam?.email) {
      emailNote = 'no email on file, so only the portal notification went out'
    } else if (!inv.payload_json) {
      emailNote = 'invoice has no payload yet, so no PDF could be attached'
    } else {
      const filename = `${inv.invoice_number}.pdf`
      const pdf = await ensureInvoicePdf(admin, {
        id: inv.id,
        period: inv.period,
        invoice_number: inv.invoice_number,
        pdf_key: inv.pdf_key,
        payload_json: inv.payload_json
      }, filename)

      if (!pdf.ok) {
        emailNote = `could not render the PDF, so no email was sent: ${pdf.error}`
      } else {
        const monthLabel = new Date(inv.period + 'T00:00:00Z')
          .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
        const total = (inv.payload_json as { total?: number } | null)?.total
        const totalLine = typeof total === 'number' ? `$${total.toFixed(2)}` : null

        const mail = invoiceReleaseEmail({
          firstName: bam.first_name ?? 'there',
          month: monthLabel,
          invoiceNumber: inv.invoice_number ?? '',
          deadline: deadlineLabel(sendEligibleAt(now)),
          portalUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/portal/invoices`,
          total: typeof total === 'number' ? total : null,
          attached: true
        })
        const sent = await sendEmail({
          to: bam.email,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          attachments: [{ filename, content: Buffer.from(pdf.bytes) }]
        })
        if (!sent.sent) emailNote = `email failed: ${sent.error}`
      }
    }

    results.push({ id: inv.id, invoice_number: inv.invoice_number, released: true })
    /*
     * Reported, never swallowed. A release whose email did not arrive is exactly the case
     * where "they had 24 hours to object" stops being true, and Robin is the only one who
     * can chase it.
     */
    const problems = [
      notified.ok ? null : `portal notification failed: ${notified.error}`,
      emailNote
    ].filter(Boolean)
    if (problems.length > 0) {
      results[results.length - 1].blocked = `released, but ${problems.join('; ')}`
    }
  }

  return NextResponse.json({
    ok: true,
    released: results.filter(r => r.released).length,
    /** Zero on a live cohort. Non-zero means the portal was told and the inbox was not. */
    dryrun_no_email: dryrunSkipped,
    window_closes: sendEligibleAt(now).toISOString(),
    results
  })
}
