/**
 * Idempotency guard for outbound invoice sends (P0-B + P0-C, audit 2026-08-07).
 *
 * What was wrong:
 *  - sendApEmail claimed "idempotent via invoice_sends UNIQUE" but had no
 *    pre-send check at all: it sent first, inserted afterwards, discarded the
 *    insert error and re-set status='sent'. Calling it twice sent two AP emails
 *    and therefore risked a duplicate real payment.
 *  - the route-level guard used .maybeSingle() without .eq('mode'). Two rows for
 *    target='ap' are legal (the UNIQUE key includes mode), and .maybeSingle()
 *    returns data=null plus an error in that case — which the code discarded,
 *    so the guard *passed* and a third email went out.
 *  - failed attempts were recorded as mode:'dryrun' with the same guard treating
 *    them as "already sent", so one failure blocked all retries forever and the
 *    BAM was never paid. There was no reset path outside manual SQL.
 *
 * Model now (schema in 0018_invoice_engine_fixes.sql):
 *   claim  -> row with status='sending', sent_at NULL   (taken BEFORE the send)
 *   ok     -> status='sent',  sent_at set               (blocks all future sends)
 *   draft  -> status='drafted', sent_at NULL            (dryrun: nothing left the building)
 *   fail   -> status='failed', sent_at NULL             (retryable immediately)
 *
 * Only `sent_at is not null` blocks. A partial unique index
 * `(invoice_id, target) where sent_at is not null` makes a second completed send
 * structurally impossible even across modes, and a stale 'sending' claim ages
 * out after STALE_CLAIM_MS so a crashed run cannot block payment permanently.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SendGuardDb = { from: (...args: any[]) => any }

export type SendTarget = 'ap' | 'bam' | 'sharepoint'
export type SendMode = 'dryrun' | 'live' | 'draft' | 'off'

export const STALE_CLAIM_MS = 10 * 60 * 1000

type SendRow = {
  id: string
  mode: string
  status: string | null
  sent_at: string | null
  started_at: string | null
  attempts: number | null
  address: string | null
}

export type ClaimResult =
  | { ok: true; sendRowId: string; attempts: number }
  | { ok: false; reason: 'already_sent' | 'in_flight' | 'race' | 'db_error'; error: string }

/**
 * Take an exclusive claim on (invoice, target) before doing anything external.
 * Fail-closed: any DB error blocks the send.
 */
export async function claimSend(
  db: SendGuardDb,
  args: { invoiceId: string; target: SendTarget; mode: SendMode; address: string }
): Promise<ClaimResult> {
  const { invoiceId, target, mode, address } = args

  // Explicit array select — never .single()/.maybeSingle() here: more than one
  // row per (invoice,target) is legal and maybeSingle() would hand us
  // data=null + error, which reads exactly like "nothing sent yet".
  const { data, error } = await db
    .from('invoice_sends')
    .select('id, mode, status, sent_at, started_at, attempts, address')
    .eq('invoice_id', invoiceId)
    .eq('target', target)

  if (error) {
    return { ok: false, reason: 'db_error', error: `invoice_sends read failed: ${error.message}` }
  }

  const rows: SendRow[] = data ?? []

  const completed = rows.find(r => r.sent_at)
  if (completed) {
    return {
      ok: false,
      reason: 'already_sent',
      error: `already sent to ${target} at ${completed.sent_at} (mode=${completed.mode}) — refusing to send again`
    }
  }

  const now = Date.now()
  const inFlight = rows.find(
    r => r.status === 'sending' && r.started_at && now - new Date(r.started_at).getTime() < STALE_CLAIM_MS
  )
  if (inFlight) {
    return {
      ok: false,
      reason: 'in_flight',
      error: `another send to ${target} started at ${inFlight.started_at} is still in flight — not sending a second copy`
    }
  }

  const nowIso = new Date().toISOString()
  const existing = rows.find(r => r.mode === mode)

  if (existing) {
    // Re-claim a failed or stale attempt as a COMPARE-AND-SET on the exact row
    // state we read.
    //
    // AUDIT-2026-08-07 F2: this used to filter on `.is('sent_at', null)` alone.
    // For the common retry shape {mode:'live', status:'failed', sent_at:null},
    // two concurrent retries both SELECTed the same row, both UPDATEd it with a
    // predicate that was still true for both, both got 1 row back, and both
    // called sendEmail. The partial unique index only trips at
    // markSendSucceeded, i.e. AFTER the second AP email has already gone out —
    // a duplicate real payment. This is precisely the retry path an operator
    // uses after a transient provider failure.
    //
    // Matching on (status, started_at) as they were at SELECT time means the
    // loser matches 0 rows and gets reason:'race' before touching the provider.
    let q = db
      .from('invoice_sends')
      .update({
        status: 'sending',
        started_at: nowIso,
        attempts: (existing.attempts ?? 0) + 1,
        last_error: null,
        address
      })
      .eq('id', existing.id)
      .is('sent_at', null)

    q = existing.status === null || existing.status === undefined
      ? q.is('status', null)
      : q.eq('status', existing.status)
    q = existing.started_at === null || existing.started_at === undefined
      ? q.is('started_at', null)
      : q.eq('started_at', existing.started_at)

    const { data: updated, error: updErr } = await q.select('id, attempts')

    if (updErr) return { ok: false, reason: 'db_error', error: `invoice_sends claim failed: ${updErr.message}` }
    const row = (updated ?? [])[0]
    if (!row) {
      return {
        ok: false,
        reason: 'race',
        error:
          'send row changed while we were claiming it (another worker took the claim or completed the send) ' +
          '— not sending a second copy'
      }
    }
    return { ok: true, sendRowId: row.id, attempts: Number(row.attempts ?? 1) }
  }

  const { data: inserted, error: insErr } = await db
    .from('invoice_sends')
    .insert({
      invoice_id: invoiceId,
      target,
      mode,
      address,
      attempts: 1,
      status: 'sending',
      started_at: nowIso,
      sent_at: null
    })
    .select('id, attempts')

  if (insErr) {
    // UNIQUE(invoice_id,target,mode) tripped = a concurrent worker claimed first.
    return { ok: false, reason: 'race', error: `invoice_sends claim insert failed: ${insErr.message}` }
  }
  const row = (inserted ?? [])[0]
  if (!row) return { ok: false, reason: 'race', error: 'invoice_sends claim insert returned no row' }
  return { ok: true, sendRowId: row.id, attempts: Number(row.attempts ?? 1) }
}

/** Record a completed send. Errors are returned, never swallowed. */
export async function markSendSucceeded(
  db: SendGuardDb,
  sendRowId: string,
  opts: { messageId?: string | null } = {}
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await db
    .from('invoice_sends')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      message_id: opts.messageId ?? null,
      last_error: null
    })
    .eq('id', sendRowId)
    .is('sent_at', null)
    .select('id')

  if (error) {
    // Includes the partial unique index (invoice_id,target) where sent_at is not
    // null. If that fires, a completed send already existed: the email has gone
    // out twice and a human has to look at it.
    return { ok: false, error: `could not record completed send ${sendRowId}: ${error.message}` }
  }
  if (!(data ?? []).length) {
    return { ok: false, error: `send row ${sendRowId} was already marked sent by another worker` }
  }
  return { ok: true }
}

/**
 * Record a dryrun/draft outcome: an Outlook draft was created, nothing left the
 * building. sent_at stays NULL on purpose so the later live send is not blocked
 * (dryrun-then-live is the intended workflow) and so a draft can be recreated.
 */
export async function markSendDrafted(
  db: SendGuardDb,
  sendRowId: string,
  opts: { messageId?: string | null } = {}
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db
    .from('invoice_sends')
    .update({ status: 'drafted', sent_at: null, message_id: opts.messageId ?? null, last_error: null })
    .eq('id', sendRowId)

  if (error) return { ok: false, error: `could not record drafted send ${sendRowId}: ${error.message}` }
  return { ok: true }
}

/** Record a failed attempt. Leaves sent_at NULL so a retry is always possible. */
export async function markSendFailed(
  db: SendGuardDb,
  sendRowId: string,
  errorMessage: string
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db
    .from('invoice_sends')
    .update({ status: 'failed', last_error: errorMessage.slice(0, 2000), sent_at: null })
    .eq('id', sendRowId)

  if (error) return { ok: false, error: `could not record failed send ${sendRowId}: ${error.message}` }
  return { ok: true }
}

/** Release a claim taken before a pre-flight check failed (nothing was sent). */
export async function releaseClaim(
  db: SendGuardDb,
  sendRowId: string,
  reason: string
): Promise<void> {
  await markSendFailed(db, sendRowId, `not sent: ${reason}`)
}
