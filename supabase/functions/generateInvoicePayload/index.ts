/**
 * Edge Function: generateInvoicePayload
 * POST { bam_id: string, period: string }  // period = "YYYY-MM-01"
 *
 * Fetches BAM (with decrypted banking), cohort, ledger row → composes the
 * 19-token payload via pure lib/invoice-payload.ts. Does NOT insert an
 * invoice row (that's the scheduler-generate orchestrator's job).
 *
 * AUDIT-2026-08-07 fixes:
 *  - P0-H: every supabase error is inspected (none were). The ledger read in
 *    particular filtered on bam_id+period only, while the ledger's unique key is
 *    (bam_id, cohort_id, period): a BAM appearing in two cohorts matched two rows
 *    and .maybeSingle() then returned data=null + error, which the old code read
 *    as "reimbursement 0" and silently underpaid.
 *  - P0-D: a missing ledger row no longer defaults to 0. lib/invoice-ledger.ts
 *    only allows 0 when there are genuinely no receipts for the month.
 *  - P1-11: initials are resolved here instead of hard-failing with
 *    "call resolveInitials first" — that Edge Function has no callers.
 *  - P1-22: seq/revision come from lib/invoice-sequence.ts, so a voided number
 *    is never handed out twice.
 */
import { serviceClient } from '../_shared/supabase-admin'
import { generateInvoicePayload } from '../../../lib/invoice-payload'
import { lookupReimbursement } from '../../../lib/invoice-ledger'
import { ensureInitialsResolved } from '../../../lib/ensure-initials'
import { resolveSeqAndRevision } from '../../../lib/invoice-sequence'

export async function handler(req: { bam_id: string; period: string }) {
  const db = serviceClient()

  const { data: bamRows, error: bamErr } = await db.from('bams').select('*').eq('id', req.bam_id)
  if (bamErr) return { ok: false, error: `bams read failed: ${bamErr.message}` }
  const bam = (bamRows ?? [])[0]
  if (!bam) return { ok: false, error: 'bam not found' }
  if (!bam.cohort_id) return { ok: false, error: 'bam has no cohort_id' }

  const [cohortRes, bankingRes] = await Promise.all([
    db.from('cohorts').select('*').eq('id', bam.cohort_id),
    db.rpc('decrypt_bam_banking', { p_bam_id: req.bam_id })
  ])

  if (cohortRes.error) return { ok: false, error: `cohorts read failed: ${cohortRes.error.message}` }
  if (bankingRes.error) return { ok: false, error: `decrypt_bam_banking failed: ${bankingRes.error.message}` }

  const cohort = (cohortRes.data ?? [])[0]
  if (!cohort) return { ok: false, error: 'cohort not found' }
  if (!cohort.po_number) return { ok: false, error: 'cohort.po_number not set — HARD BLOCK' }

  const bankingRow = Array.isArray(bankingRes.data) ? bankingRes.data[0] : bankingRes.data
  const banking = bankingRow as Record<string, string> | null | undefined
  if (!banking || !banking.institution_no || !banking.transit_no || !banking.account_no) {
    return { ok: false, error: 'banking decryption failed or incomplete — HARD BLOCK, a blank direct-deposit block must never reach AP' }
  }

  const ledger = await lookupReimbursement(db, req.bam_id, bam.cohort_id, req.period)
  if (!ledger.ok) return { ok: false, error: ledger.error }

  const initials = await ensureInitialsResolved(db, req.bam_id, bam.cohort_id)
  if (!initials.ok) return { ok: false, error: initials.error }

  const sequence = await resolveSeqAndRevision(db, req.bam_id, bam.cohort_id, req.period)
  if (!sequence.ok) return { ok: false, error: sequence.error }
  if (sequence.existingId) {
    return {
      ok: false,
      existing_invoice_id: sequence.existingId,
      error: `invoice ${sequence.existingNumber ?? sequence.existingId} already exists for this period (status ${sequence.existingStatus}) — nothing generated`
    }
  }

  try {
    const payload = generateInvoicePayload({
      bam: {
        firstName: bam.first_name, lastName: bam.last_name,
        street: bam.street ?? '', city: bam.city ?? '', prov: bam.prov ?? '', postal: bam.postal ?? '',
        email: bam.email, phone: bam.phone ?? '',
        bankName: bam.bank_name ?? '',
        institutionNo: banking.institution_no,
        transitNo: banking.transit_no,
        accountNo: banking.account_no,
        hstNumber: banking.hst_number,
        initialsResolved: initials.initials
      },
      cohort: {
        programLabel: cohort.program_label,
        poNumber: cohort.po_number,
        salaryDefault: Number(cohort.salary_default),
        currency: 'CAD'
      },
      ledger: { paidCad: ledger.paidCad },
      period: new Date(req.period),
      seq: sequence.seq,
      revision: sequence.revision,
      generatedAt: new Date()
    })

    return {
      ok: true,
      payload,
      seq: sequence.seq,
      revision: sequence.revision,
      invoice_number: payload.invoiceNumber
    }
  } catch (e) {
    return { ok: false, error: `payload generation failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
