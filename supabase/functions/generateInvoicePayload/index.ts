/**
 * Edge Function: generateInvoicePayload
 * POST { bam_id: string, period: string }  // period = "YYYY-MM-01"
 *
 * Fetches BAM (with decrypted banking), cohort, ledger row → composes the
 * 19-token payload via pure lib/invoice-payload.ts. Does NOT insert an
 * invoice row (that's generate-invoice orchestrator's job).
 */
import { serviceClient } from '../_shared/supabase-admin'
import { generateInvoicePayload } from '../../../lib/invoice-payload'

export async function handler(req: { bam_id: string; period: string }) {
  const db = serviceClient()

  const [{ data: bam }, { data: cohort }, { data: ledger }, { data: banking }] = await Promise.all([
    db.from('bams').select('*').eq('id', req.bam_id).single(),
    (async () => {
      const { data: b } = await db.from('bams').select('cohort_id').eq('id', req.bam_id).single()
      return b ? db.from('cohorts').select('*').eq('id', b.cohort_id).single()
               : { data: null }
    })(),
    db.from('reimbursement_ledger').select('paid_usd').eq('bam_id', req.bam_id).eq('period', req.period).maybeSingle(),
    db.rpc('decrypt_bam_banking', { p_bam_id: req.bam_id }).single()
  ])

  if (!bam)    return { ok: false, error: 'bam not found' }
  if (!cohort) return { ok: false, error: 'cohort not found' }
  if (!banking) return { ok: false, error: 'banking decryption failed' }
  if (!bam.initials_resolved) return { ok: false, error: 'initials_resolved not set — call resolveInitials first' }
  if (!cohort.po_number)      return { ok: false, error: 'cohort.po_number not set — HARD BLOCK' }

  // Next seq
  const { data: prevMax } = await db
    .from('invoices').select('seq').eq('bam_id', req.bam_id)
    .in('status', ['draft','sent','paid']).order('seq', { ascending: false }).limit(1).maybeSingle()
  const seq = (prevMax?.seq ?? 0) + 1

  const payload = generateInvoicePayload({
    bam: {
      firstName: bam.first_name, lastName: bam.last_name,
      street: bam.street ?? '', city: bam.city ?? '', prov: bam.prov ?? '', postal: bam.postal ?? '',
      email: bam.email, phone: bam.phone ?? '',
      bankName: bam.bank_name ?? '',
      institutionNo: (banking as any).institution_no,
      transitNo: (banking as any).transit_no,
      accountNo: (banking as any).account_no,
      hstNumber: (banking as any).hst_number,
      initialsResolved: bam.initials_resolved
    },
    cohort: {
      programLabel: cohort.program_label,
      poNumber: cohort.po_number,
      salaryDefault: Number(cohort.salary_default),
      currency: 'CAD'
    },
    ledger: { paidUsd: Number(ledger?.paid_usd ?? 0) },
    period: new Date(req.period),
    seq,
    generatedAt: new Date()
  })

  return { ok: true, payload, seq, invoice_number: payload.invoiceNumber }
}
