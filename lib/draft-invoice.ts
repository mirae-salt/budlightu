import { createClient } from '@supabase/supabase-js'
import { generateInvoicePayload } from './invoice-payload'
import { formatInvoiceNumber } from './invoice-numbering'

type AdminClient = ReturnType<typeof createClient>

export async function upsertDraftInvoice(
  db: AdminClient,
  bamId: string,
  cohortId: string,
  period: string
) {
  const [{ data: bam }, { data: cohort }, { data: receipts }, { data: banking }, { data: existing }] = await Promise.all([
    db.from('bams').select('first_name, last_name, email, phone, street, city, prov, postal, bank_name, initials_resolved, cohort_id').eq('id', bamId).single(),
    db.from('cohorts').select('program_label, po_number, salary_default').eq('id', cohortId).single(),
    db.from('receipts').select('bud_light_total_incl_tax').eq('bam_id', bamId).eq('period', period).in('status', ['approved', 'auto_pass']),
    db.rpc('decrypt_bam_banking', { p_bam_id: bamId }).maybeSingle(),
    db.from('invoices').select('id, seq, invoice_number').eq('bam_id', bamId).eq('cohort_id', cohortId).eq('period', period).neq('status', 'void').maybeSingle()
  ])

  if (!bam || !cohort) return

  const reimbTotal = Math.min(
    (receipts ?? []).reduce((s, r) => s + ((r as { bud_light_total_incl_tax: number | null }).bud_light_total_incl_tax ?? 0), 0),
    150
  )

  let seq = existing?.seq
  if (!seq) {
    const { data: prevMax } = await db.from('invoices')
      .select('seq').eq('bam_id', bamId)
      .in('status', ['draft', 'sent', 'paid'])
      .order('seq', { ascending: false }).limit(1).maybeSingle()
    seq = (prevMax?.seq ?? 0) + 1
  }

  const initials = bam.initials_resolved ?? `${bam.first_name[0]}${bam.last_name[0]}`.toUpperCase()
  const invoiceNumber = existing?.invoice_number ?? formatInvoiceNumber(initials, seq)
  const hasBanking = banking && (banking as Record<string, unknown>).institution_no

  let payload: Record<string, unknown>
  if (hasBanking) {
    payload = generateInvoicePayload({
      bam: {
        firstName: bam.first_name, lastName: bam.last_name,
        street: bam.street ?? '', city: bam.city ?? '', prov: bam.prov ?? '', postal: bam.postal ?? '',
        email: bam.email, phone: bam.phone ?? '',
        bankName: bam.bank_name ?? '',
        institutionNo: (banking as Record<string, string>).institution_no,
        transitNo: (banking as Record<string, string>).transit_no,
        accountNo: (banking as Record<string, string>).account_no,
        hstNumber: (banking as Record<string, string>).hst_number,
        initialsResolved: initials
      },
      cohort: {
        programLabel: cohort.program_label,
        poNumber: cohort.po_number,
        salaryDefault: Number(cohort.salary_default),
        currency: 'CAD'
      },
      ledger: { paidCad: reimbTotal },
      period: new Date(period),
      seq,
      generatedAt: new Date()
    }) as unknown as Record<string, unknown>
  } else {
    const salary = Number(cohort.salary_default ?? 218.75)
    const subtotal = salary + reimbTotal
    const periodDate = new Date(period)
    const monthLong = periodDate.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
    const lines: { qty: number; description: string; unitPrice: number; total: number }[] = [
      { qty: 1, description: `Brand Activation Manager monthly payment (${monthLong} Payment)`, unitPrice: salary, total: salary }
    ]
    if (reimbTotal > 0) {
      lines.push({ qty: 1, description: `Reimbursement for sponsorship allowance (${monthLong})`, unitPrice: reimbTotal, total: reimbTotal })
    }
    payload = {
      invoiceNumber,
      invoiceDate: new Date().toISOString(),
      period: periodDate.toISOString().slice(0, 10),
      toBlock: { company: 'Salt Experiential Commerce, Inc.', address: '249 Dufferin Street Toronto, ON, M6K 1Z5', attn: ['Robin Graham (robin.graham@ilovesalt.com)', 'Nathan Brown (nb@ilovesalt.com)'] },
      influencer: { name: `${bam.first_name} ${bam.last_name}`, street: '', cityProvPostal: '', email: bam.email ?? '', phone: '' },
      commentsLabel: cohort.program_label ?? 'BUD LIGHT U',
      jobNumber: cohort.po_number ?? '',
      lines, subtotal, tax: 0, total: subtotal,
      makeChecksTo: `${bam.first_name} ${bam.last_name}`,
      contact: '',
      directDeposit: { bank: '', institutionNumber: '', transitNumber: '', accountNumber: '', email: bam.email ?? '' },
      footer: { programTitle: 'BUD LIGHT CAMPUS INVOICE', invoiceNumber, dateReadable: '' },
      currency: 'CAD'
    }
  }

  if (existing) {
    await db.from('invoices').update({ payload_json: payload }).eq('id', existing.id)
  } else {
    await db.from('invoices').insert({
      bam_id: bamId, cohort_id: cohortId, period, seq,
      invoice_number: invoiceNumber, payload_json: payload,
      status: 'draft', currency: 'CAD'
    })
  }
}
