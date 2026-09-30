/**
 * What an admin edit on the roster has to do about the student's invoice.
 *
 * WHY THIS EXISTS
 *
 * An invoice was only ever created in two places: the monthly job on the 1st, for every
 * BAM who is active that day, and the end of onboarding. An admin who filled in a mailing
 * address and set a student to active created neither. Lea Major joined on 2026-09-02,
 * uploaded two receipts while still pending, and had an approved reimbursement and no
 * invoice to put it on. The roster form could already fix everything the invoice needed;
 * nothing then asked for the invoice.
 *
 * The student's own confirmations (terms, work authorization, banking, email) are not
 * something an admin can give on their behalf, and nothing in the send path checks them.
 * Activating without them is allowed, because the alternative is a student who cannot be
 * paid for a step the office could have finished, but it is said out loud and recorded.
 * The dashboard's attestation prompt asks the student for them at the next sign-in.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { seedPeriodInvoice } from './seed-period-invoice'

export type ConfirmationRow = {
  email_verified_at?: string | null
  consent_terms_at?: string | null
  work_auth_attested_at?: string | null
  banking_attested_at?: string | null
}

/** Columns to select for missingConfirmations. */
export const CONFIRMATION_COLUMNS =
  'email_verified_at, consent_terms_at, work_auth_attested_at, banking_attested_at'

/** What the student has not yet confirmed, in the words an admin would use. */
export function missingConfirmations(row: ConfirmationRow | null | undefined): string[] {
  const out: string[] = []
  if (!row?.email_verified_at) out.push('email verification')
  if (!row?.consent_terms_at) out.push('terms')
  if (!row?.work_auth_attested_at) out.push('work authorization')
  if (!row?.banking_attested_at) out.push('banking confirmation')
  return out
}

/**
 * Should saving this edit try to open the invoice?
 *
 * Yes when the student just became active, and also when an already-active student's
 * address or bank was filled in, because the monthly job skips someone whose address is
 * blank and nothing comes back for them. Never for a test account, and never for a
 * student who is not active: seed-period-invoice explains why a half-onboarded student
 * must not get a payable document.
 */
export function shouldSeedAfterEdit(args: {
  beforeStatus: unknown
  afterStatus: unknown
  isTest: unknown
  changedKeys: readonly string[]
}): boolean {
  if (args.afterStatus !== 'active' || args.isTest === true) return false
  if (args.beforeStatus !== 'active') return true
  return args.changedKeys.some(k => ['street', 'city', 'prov', 'postal', 'bank_name'].includes(k))
}

export type SeedIfMissingOutcome = {
  ok: boolean
  created: boolean
  /** True when there was nothing to do, so the caller should not paint it as a problem. */
  quiet: boolean
  note: string
}

type Db = Parameters<typeof seedPeriodInvoice>[0]
type SeedFn = typeof seedPeriodInvoice

/**
 * Open the invoice for one student and month, but only if there is not one already.
 *
 * seedPeriodInvoice is idempotent and rewrites the draft it finds. An admin may have added
 * a bar tab to that draft, so an existing invoice of any status is left alone here.
 */
export async function seedIfMissing(
  db: Db,
  args: { bamId: string; cohortId: string; period: string; monthLabel: string },
  seed: SeedFn = seedPeriodInvoice
): Promise<SeedIfMissingOutcome> {
  const sb = db as unknown as SupabaseClient

  const { data: cohortRows, error: cErr } = await sb.from('cohorts')
    .select('start_date, end_date').eq('id', args.cohortId)
  if (cErr) return { ok: false, created: false, quiet: false, note: `Could not read the cohort dates (${cErr.message}), so no ${args.monthLabel} invoice was made.` }
  const cohort = (cohortRows ?? [])[0] as { start_date: string; end_date: string } | undefined
  if (!cohort) return { ok: false, created: false, quiet: false, note: `Cohort not found, so no ${args.monthLabel} invoice was made.` }
  if (args.period < String(cohort.start_date) || args.period > String(cohort.end_date)) {
    return { ok: true, created: false, quiet: true, note: `The program does not run in ${args.monthLabel}, so there is no invoice to make.` }
  }

  const { data: existing, error: eErr } = await sb.from('invoices')
    .select('id, invoice_number, status').eq('bam_id', args.bamId).eq('period', args.period)
  if (eErr) return { ok: false, created: false, quiet: false, note: `Could not check for an existing ${args.monthLabel} invoice (${eErr.message}), so none was made.` }
  const found = ((existing as Array<{ invoice_number?: string; status?: string }> | null) ?? [])[0]
  if (found) {
    return {
      ok: true, created: false, quiet: true,
      note: `${args.monthLabel} invoice ${found.invoice_number ?? ''} already exists (${found.status ?? 'unknown status'}), left as it is.`.replace('  ', ' ')
    }
  }

  const out = await seed(db, { bamId: args.bamId, cohortId: args.cohortId, period: args.period })
  if (!out.ok) {
    return { ok: false, created: false, quiet: false, note: `No ${args.monthLabel} invoice was made: ${out.reason}` }
  }
  return {
    ok: true, created: true, quiet: false,
    note: `${args.monthLabel} draft invoice ${out.invoiceNumber ?? ''} created.`.replace('  ', ' ')
  }
}
