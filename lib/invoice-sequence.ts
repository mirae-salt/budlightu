/**
 * Per-BAM invoice sequence + revision resolution (P1-22, audit 2026-08-07).
 *
 * Two problems this centralises:
 *  1. seq was computed as max(seq) over status in (draft,sent,paid) only, so a
 *     voided invoice's seq was handed out again — the same INV-LG3 could exist
 *     twice with different amounts because the partial unique index excludes
 *     void rows. Now the max is taken over ALL statuses, so a number is never
 *     recycled, and a reissue of the same period keeps its seq but bumps the
 *     revision → INV-LG3-R2.
 *  2. draft-invoice.ts and generateInvoicePayload each had their own version of
 *     this arithmetic.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SequenceDb = { from: (...args: any[]) => any }

export type SequenceResult =
  | {
      ok: true
      seq: number
      revision: number
      /** set when a non-void invoice for this period already exists (update path) */
      existingId?: string
      existingNumber?: string
      existingStatus?: string
    }
  | { ok: false; error: string }

type InvoiceRow = {
  id: string
  seq: number | null
  revision: number | null
  invoice_number: string | null
  status: string | null
}

export async function resolveSeqAndRevision(
  db: SequenceDb,
  bamId: string,
  cohortId: string,
  period: string
): Promise<SequenceResult> {
  // All rows for this period, void included — array select, error inspected.
  const { data: periodRows, error: periodErr } = await db
    .from('invoices')
    .select('id, seq, revision, invoice_number, status')
    .eq('bam_id', bamId)
    .eq('cohort_id', cohortId)
    .eq('period', period)

  if (periodErr) return { ok: false, error: `invoices read failed: ${periodErr.message}` }

  const rows: InvoiceRow[] = periodRows ?? []
  const live = rows.filter(r => r.status !== 'void')

  if (live.length > 1) {
    return {
      ok: false,
      error: `${live.length} non-void invoices already exist for bam ${bamId} / period ${period} — refusing to touch either`
    }
  }

  if (live.length === 1) {
    const l = live[0]
    if (!l.seq) return { ok: false, error: `existing invoice ${l.id} has no seq` }
    return {
      ok: true,
      seq: Number(l.seq),
      revision: Number(l.revision ?? 1),
      existingId: l.id,
      existingNumber: l.invoice_number ?? undefined,
      existingStatus: l.status ?? undefined
    }
  }

  const voided = rows.filter(r => r.status === 'void')
  if (voided.length > 0) {
    // Reissue: keep the sequence, bump the revision so AP can never see two
    // different documents under one number.
    const seq = Math.max(...voided.map(v => Number(v.seq ?? 0)))
    const revision = Math.max(...voided.map(v => Number(v.revision ?? 1))) + 1
    if (!Number.isInteger(seq) || seq < 1) {
      return { ok: false, error: `voided invoice for period ${period} has an unusable seq` }
    }
    return { ok: true, seq, revision }
  }

  // Brand new period: next seq across every invoice this BAM has ever had,
  // including voided ones, so numbers are never recycled.
  const { data: maxRows, error: maxErr } = await db
    .from('invoices')
    .select('seq')
    .eq('bam_id', bamId)
    .order('seq', { ascending: false })
    .limit(1)

  if (maxErr) return { ok: false, error: `invoices max(seq) read failed: ${maxErr.message}` }
  const prevMax = Number((maxRows ?? [])[0]?.seq ?? 0)
  return { ok: true, seq: prevMax + 1, revision: 1 }
}
