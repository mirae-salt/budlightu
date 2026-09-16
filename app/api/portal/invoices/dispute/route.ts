/**
 * POST /api/portal/invoices/dispute  { invoice_id, reason }
 *
 * A BAM says something is wrong with their own invoice during the 24-hour window Legal
 * asked for on 2026-09-16. It opens a normal support thread that points at the invoice,
 * and while that thread is unanswered, batch-approve refuses to send the invoice to AP.
 *
 * WHY THIS IS A QUESTION AND NOT ITS OWN KIND OF RECORD
 * -----------------------------------------------------
 * It was a one-shot objection with a reason and a resolution, which is a worse version of
 * what portal_questions already is. Threads here already notify the admins when one
 * opens, notify the BAM when it is answered, mirror the whole conversation to email, and
 * have a screen on both sides. Objections need every one of those, and Mirae asked for
 * the back and forth explicitly (2026-09-16: "스레드로 question / flag 그 자리에서 하고
 * bam한테도 알람가게"). A separate table would have been a second inbox that nobody
 * wired an email into.
 *
 * So this route is the support route with an invoice attached, deliberately sharing
 * `alertAdminsAboutQuestion` so an invoice objection reaches Robin exactly the way a
 * support question does.
 *
 * ACCEPTED AFTER THE WINDOW CLOSES TOO. The window decides when we may SEND, not when
 * somebody is allowed to speak. A BAM who spots a problem on hour 30 still has a real
 * problem, and a form that answers "too late" teaches them to email Robin instead, which
 * is the channel this exists to replace. If the invoice has already gone to AP the thread
 * still opens and still reaches Robin; it just cannot un-send an email, and the response
 * says so rather than letting them assume otherwise.
 */
import { NextRequest, NextResponse } from 'next/server'
import { serviceClient } from '../../../../../supabase/functions/_shared/supabase-admin'
import { requireBam, denied } from '../../../../../lib/admin-auth'
import { alertAdminsAboutQuestion } from '../../../../../lib/question-alert'

/** Long enough to be a sentence. An empty objection tells Robin nothing and holds a payment. */
const MIN_REASON = 10

export async function POST(req: NextRequest) {
  const auth = await requireBam()
  if (!auth.ok) return denied(auth)

  const body = await req.json().catch(() => ({}))
  const invoiceId = typeof body?.invoice_id === 'string' ? body.invoice_id : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''

  if (!invoiceId) {
    return NextResponse.json({ ok: false, message: 'invoice_id required' }, { status: 400 })
  }
  if (reason.length < MIN_REASON) {
    return NextResponse.json({
      ok: false,
      message: `Tell us what looks wrong, in at least ${MIN_REASON} characters, so your program manager can check the right thing.`
    }, { status: 400 })
  }

  const admin = serviceClient()

  /*
   * The invoice must be THIS BAM's. The service role bypasses RLS, so ownership is
   * checked here rather than assumed: without it any signed-in student could hold
   * anyone else's payment by posting an id.
   */
  const { data: invoice, error: invErr } = await admin.from('invoices')
    .select('id, bam_id, invoice_number, period, status, released_at')
    .eq('id', invoiceId)
    .maybeSingle()
  if (invErr) {
    return NextResponse.json({ ok: false, message: `could not read that invoice: ${invErr.message}` }, { status: 500 })
  }
  if (!invoice || invoice.bam_id !== auth.bamId) {
    // Same answer for "does not exist" and "is not yours", so this cannot be used to
    // find out whose invoice an id belongs to.
    return NextResponse.json({ ok: false, message: 'Invoice not found' }, { status: 404 })
  }
  if (!invoice.released_at) {
    return NextResponse.json({
      ok: false,
      message: 'This invoice has not been finalised yet, so there is nothing to check over. You will be told when it is ready.'
    }, { status: 400 })
  }

  // One open thread per invoice. A second one would have to be answered separately to
  // unblock the send, and it is nearly always the same person adding detail, which is
  // what replying to the thread is for.
  const { data: existing, error: exErr } = await admin.from('portal_questions')
    .select('id')
    .eq('invoice_id', invoiceId)
    .is('answered_at', null)
    .maybeSingle()
  if (exErr) {
    return NextResponse.json({ ok: false, message: `could not check your existing message: ${exErr.message}` }, { status: 500 })
  }
  if (existing) {
    return NextResponse.json({
      ok: false,
      message: 'You already have a question open on this invoice. Reply on that thread to add anything, and nothing will be sent until it is sorted out.',
      question_id: existing.id
    }, { status: 409 })
  }

  const { data: bam, error: bamErr } = await admin.from('bams')
    .select('id, first_name, last_name, email, school_id, cohort_id, cohorts(name)')
    .eq('id', auth.bamId)
    .maybeSingle()
  if (bamErr || !bam) {
    return NextResponse.json({ ok: false, message: 'Could not read your roster record.' }, { status: 500 })
  }

  const label = `Invoice ${invoice.invoice_number ?? invoiceId}`
  const questionText = `${label}: ${reason}`.slice(0, 4000)

  const { data: inserted, error: insErr } = await admin.from('portal_questions').insert({
    bam_id: auth.bamId,
    cohort_id: bam.cohort_id,
    invoice_id: invoiceId,
    question: questionText
  }).select('id').single()
  if (insErr) {
    return NextResponse.json({ ok: false, message: `could not record that: ${insErr.message}` }, { status: 500 })
  }

  /*
   * The student's own words as the thread's first message. Not fatal if it fails: the
   * text is already on `portal_questions.question` and the admin screen falls back to
   * that column. Found the hard way on 2026-08-14, when a thread rendered the answer
   * with the student's question missing.
   */
  const { error: msgErr } = await admin.from('portal_question_messages').insert({
    question_id: inserted.id,
    author: 'bam',
    body: reason.slice(0, 4000)
  })
  if (msgErr) console.error('[invoice/dispute] first thread message failed:', msgErr.message)

  const cohortRel = (bam as unknown as { cohorts?: { name?: string } | Array<{ name?: string }> | null }).cohorts
  const cohortRow = Array.isArray(cohortRel) ? cohortRel[0] : cohortRel

  // The same fanout a support question gets: admin email plus the in-app notification.
  const alert = await alertAdminsAboutQuestion(admin, {
    kind: 'new',
    questionId: inserted.id,
    bamId: auth.bamId,
    bamName: `${bam.first_name ?? ''} ${bam.last_name ?? ''}`.trim() || 'A BAM',
    bamEmail: bam.email ?? '',
    bamSchool: bam.school_id,
    bamCohort: cohortRow?.name ?? null,
    message: `${label} (${invoice.period}) -- the BAM says this is wrong and the invoice is held until this is answered:\n\n${reason}`,
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? ''
  })

  return NextResponse.json({
    ok: true,
    question_id: inserted.id,
    // Said out loud rather than implied: an invoice already at AP cannot be recalled, and
    // the student should hear that from us instead of discovering it.
    already_sent: invoice.status !== 'draft',
    admin_notified: alert.notified || alert.emailed
  })
}
