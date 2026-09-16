import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getMonthlyBalance } from '@/lib/balance'
import { classifyReceipt, recomputeBudLightTotal, type OcrResult, depositShapedGap, isDepositLine } from '@/lib/classify-receipt'
import { DEFAULT_POLICY } from '@/lib/policy'
import { parseNonNegativeMoney } from '@/lib/money'
import { cleanEnvValue } from '@/lib/sanitize'

const RECEIPT_PROMPT = `You are an audit assistant reading a Canadian retail receipt image. Return JSON only.

Task:
1) OCR every line item with: description (EXACT text as printed), unit_price, qty, line_total.
2) Classify each line as bud_light (true/false). A line is Bud Light if it matches
   ANY of these patterns (learned from ~400 real Canadian receipts):

   KNOWN BUD LIGHT TEXT PATTERNS (case-insensitive, learned from 400+ real receipts):
   - "BUD LIGHT" (with any suffix: LIME, LIME TIME, LEMON LIME, APPLE, CHELADA,
     SPICY CHELADA, DOUBLE LIME, SELTZER, LAGER, PLATINUM, GOLD, BEER, BIERE, etc.)
   - "BUDLIGHT" (no space — small POS systems)
   - "BUD LT" (Couche-Tard QC, Beer Store, e.g. "BUD LT SELTZER MIX 12X")
   - "BUD LIME", "BUD D LIME", "BUD DBL LIME" (Calgary Co-op, Real Canadian)
   - "BL " followed by flavor/size (Beer Store: "BL STRAWBERRY LEMON, 473ML 6TC CAN",
     "BL SELTZER MIX 24UC")
   - "LABATT" + "BUD" (BCL BC: "LABATT BUD LIGHT CAN 15X355ml")
   - "BUD LIGHT LIME LABATT 4" (Beer Store brand-suffixed format)
   - "BUD CHELADA" / "BUD SPICY CHELADA" (sub-brand, no "LIGHT" needed)
   - "BUD LIGHT JAYS INCASE" (Blue Jays promo pack)
   - Thermal print artifacts: "BUD LIOT", "BUD L1AT", "BJD LIGHT" (LCBO printers)
   - French POS: "BUDLIG.BIERE CAN", "BUDLISELT.EAU P.", "BUDLIG.PR.PARTN." (Metro/Super C)
   - "(BUD LIGHT LIME)****-SKU" (Liquor House parenthesized SKU format)
   - Bar/restaurant: "16oz DFT Bud Light" (draft), "Can Bud Light"
   - "Bud Light Light Beer Cans" (Instacart/Uber Eats)
   - "Double Lime" alone on a liquor-store receipt (Safeway may drop "Bud Light" prefix)

   NOT Bud Light: Budweiser, Michelob, SVNS Hard 7UP, White Claw, Smirnoff,
   Corona, Blood Brothers Blood Light, Cottage Springs, Coors Seltzer, Palm Bay,
   Twisted Tea, or any non-AB InBev brand.

3) Extract: store, date, subtotal, tax (HST/GST/PST/TPS+TVQ), grand_total.
4) Return confidence for each line (0.0–1.0) and overall receipt confidence.
5) Flag ambiguity ONLY if the text is genuinely unclear (blurry, cut off).
   Normal store abbreviations like "BL TALL CAN 6X" are NOT ambiguous — they
   are standard Beer Store formatting.

Return JSON schema:
{ "store": string, "date": string, "currency": string,
  "lines": [{ "desc": string, "qty": number, "unit": number, "total": number,
              "is_bud_light": boolean, "confidence": number,
              "ambiguous"?: boolean, "reason"?: string }],
  "subtotal": number, "tax": number, "grand_total": number,
  "bud_light_total_incl_tax": number, "overall_confidence": number,
  "receipt_type"?: "retail" | "bar_restaurant" | "online_order" | "delivery_app" | "not_a_receipt",
  "notes"?: string }

Never invent values. If unreadable, set confidence=0 and add to notes.
If the image is NOT a product receipt (bus ticket, Uber ride, bank notification,
criminal record check, etc.), set receipt_type="not_a_receipt" and confidence=0.`

type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
type OcrLine = { desc?: string; qty?: number; unit?: number; total?: number; is_bud_light?: boolean; ambiguous?: boolean; confidence?: number; reason?: string }

// ── Fraud detection helpers (zero tokens — pure code logic) ──────────────

function checkExif(_bytes: Uint8Array, _mediaType: string): string[] {
  // PNG/no-EXIF checks removed: real BAM receipts come in PNG, JPG, HEIC etc.
  // Format alone is not a fraud signal.
  return []
}

function checkOcrPatterns(ocr: Record<string, unknown>, mixedLines: boolean): string[] {
  const flags: string[] = []
  const store = ((ocr.store as string) ?? '').trim()
  const date = ((ocr.date as string) ?? '').trim()
  const tax = (ocr.tax as number) ?? 0
  const subtotal = (ocr.subtotal as number) ?? 0
  const grandTotal = (ocr.grand_total as number) ?? 0
  const receiptType = (ocr.receipt_type as string) ?? ''

  if (receiptType === 'not_a_receipt')
    flags.push('not_a_receipt: image is not a product receipt (bus ticket, ride receipt, bank notification, etc.)')

  /*
   * Robin, 2026-09-04: "BAM purchases made at bars or restaurants are being flagged.
   * Can we make it so that they are only be flagged if they are part of a mixed
   * receipt?"
   *
   * A bar tab of nothing but Bud Light is the program working. Thomas Levesque's SHAKER
   * receipt was three glasses of Bud Light for $17.97 and went to the review queue with
   * "not eligible for reimbursement", which was both wrong and discouraging.
   *
   * The flag survives for the case it was written for: a tab with food and other drinks
   * on it, where somebody has to decide what part of the bill was Bud Light. That is
   * what `mixedLines` says, so it is passed in rather than re-derived here.
   */
  if (receiptType === 'bar_restaurant' && mixedLines)
    flags.push('bar_restaurant: this bar or restaurant bill has items that are not Bud Light, so the Bud Light share needs checking')

  if (receiptType === 'delivery_app')
    flags.push('delivery_app: this is a delivery app order (Uber Eats, Instacart, etc.) -- needs admin review')

  if (!store || store.length < 2) flags.push('no_store: no identifiable store name on receipt')

  if (subtotal > 0 && tax > 0) {
    const rate = tax / subtotal
    if (rate < 0.04 || rate > 0.16)
      flags.push(`unusual_tax: ${(rate * 100).toFixed(1)}% tax rate outside normal Canadian range (5–15%)`)
  }

  if (subtotal > 0 && grandTotal > 0 && tax > 0) {
    const expected = subtotal + tax
    const diff = Math.abs(expected - grandTotal)
    /*
     * A container deposit is charged on top of the subtotal and is not taxed, and the
     * Beer Store and ACE Liquor give it no line of its own, so their receipts genuinely
     * total more than their own subtotal plus tax. Three of those were flagged in the
     * first week of September with nothing wrong with them. depositShapedGap forgives
     * only a gap in that direction and of that size; a delivery fee is still flagged.
     */
    if (diff > 2.00 && diff / grandTotal > 0.03 && !depositShapedGap(subtotal, tax, grandTotal))
      // Written to be read: "grand_total" is a column name, not a thing on a receipt.
      flags.push(`total_mismatch: subtotal ($${subtotal.toFixed(2)}) plus tax ($${tax.toFixed(2)}) comes to $${expected.toFixed(2)}, but the receipt total is $${grandTotal.toFixed(2)}`)
  }

  return flags
}

/*
 * THERE IS NO PRICE CHECK HERE, AND THAT IS DELIBERATE. Removed 2026-09-08.
 *
 * There used to be one: a Bud Light line outside $2 to $70 per unit was flagged as a
 * possible misread. It never worked, because it needs to know what a Bud Light costs and
 * we do not. The price depends on the province, the store, the pack size and the format,
 * and the range those produce is enormous: a 24oz can at Rogers Stadium is $19.00 and a
 * 36-pack at Costco is $89.99, both perfectly ordinary. Prices also move over time and
 * nothing here would notice. The bounds were a guess wearing the name of a check.
 *
 * `qty` on these receipts counts PACKS, so it was not even measuring a unit price.
 *
 * The evidence, over the 38 receipts on file: it fired twice and was wrong both times.
 * Once on that real Costco 36-pack, once on a $1.20 deposit line the model had ticked as
 * Bud Light, which came in under the $2 floor. It was NEVER the only reason a receipt
 * needed a person. A check that is reliably wrong teaches the reader to skim the queue,
 * which is the one thing touchpoint 1 cannot survive.
 *
 * What actually guards a misread price, none of which needs to know a price:
 *   - grandTotalIsSane bounds the printed total at the sum of the lines plus 30%
 *   - exceedsGrandTotal refuses a Bud Light total above the receipt's own total
 *   - total_mismatch compares the model's figure against the server recompute
 *   - the cap check sends anything at or over $150 to a person regardless
 *
 * Before adding this back, bring a source for the prices.
 */

/**
 * P1-5: `availableBalance` used to be a constant (the full cap) because
 * lib/balance.ts queried a non-existent column, so over_balance and
 * near_balance_pattern were both permanently dead. With the balance now real,
 * the amount compared against it is the SERVER-RECOMPUTED Bud Light total
 * (`blTotalInclTax`), not the receipt grand total: only Bud Light spend consumes
 * the cap, and comparing a mixed grocery receipt's grand total against the Bud
 * Light balance would flag ordinary shopping as fraud. This matches
 * supabase/functions/ocrReceipt.
 */
function checkHistoricalPatterns(
  currentOcr: Record<string, unknown>,
  othersOcr: Array<{ ocr_json: Record<string, unknown> | null }>,
  availableBalance: number,
  blTotalInclTax: number,
  cap: { corroborated: boolean; capCad: number }
): string[] {
  if (othersOcr.length < 2) return []
  const flags: string[] = []
  const store = ((currentOcr.store as string) ?? '').toLowerCase().trim()

  const pastTotals: number[] = []
  const pastStores: string[] = []
  for (const o of othersOcr) {
    if (!o.ocr_json) continue
    const t = parseNonNegativeMoney(o.ocr_json.bud_light_total_incl_tax)
    const s = ((o.ocr_json.store as string) ?? '').toLowerCase().trim()
    if (t != null) pastTotals.push(t)
    if (s) pastStores.push(s)
  }

  /*
   * Spending past what is left follows the same rule as spending past the cap, decided
   * with Mirae on 2026-09-09. Going over costs nothing, because the remaining balance is
   * what gets reimbursed either way, so this is only worth a person's time when the figure
   * itself is in doubt.
   *
   * Two conditions were added:
   *
   *   The receipt's own printed total must not confirm the amount. When it does, a misread
   *   would have to corrupt the line items and the printed total identically, which is the
   *   same argument that lets an over-cap receipt clear.
   *
   *   It stays quiet once the amount reaches the full monthly cap, because the classifier
   *   already says so in better words. Thomas Ambrosio's receipt carried both, and read on
   *   screen they were the same sentence twice. What is left is the case this check is
   *   actually for: an amount UNDER the cap but over what the month has left.
   */
  const coveredByTheCapMessage = cap.capCad > 0 && blTotalInclTax >= cap.capCad
  if (
    blTotalInclTax > availableBalance && availableBalance > 0 &&
    !coveredByTheCapMessage &&
    !cap.corroborated
  ) {
    flags.push(
      `over_balance: Bud Light total $${blTotalInclTax.toFixed(2)} is more than the ` +
      `$${availableBalance.toFixed(2)} left this month, and the receipt's own total does not ` +
      `confirm that figure -- check the amount before the balance is paid`
    )
  }

  const nearBalance = (v: number) => availableBalance > 0 && Math.abs(v - availableBalance) / availableBalance < 0.07
  const nearCount = pastTotals.filter(nearBalance).length + (nearBalance(blTotalInclTax) ? 1 : 0)
  if (nearCount >= 3)
    flags.push(`near_balance_pattern: ${nearCount} receipts clustered near available balance ($${availableBalance.toFixed(2)}) -- possible gaming`)

  if (store && pastStores.length >= 5 && pastStores.every(s => s === store))
    flags.push(`same_store_always: all ${pastStores.length + 1} receipts from "${store}" -- unusual variety`)

  return flags
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Only these vetted vision models may read receipts — a typo'd or ":free"/"auto"
// env var must fail loudly, never silently route to an unverified model.
const APPROVED_OCR_MODELS = [
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-flash',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4',
] as const

const OCR_MODEL = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4'
if (!APPROVED_OCR_MODELS.includes(OCR_MODEL as typeof APPROVED_OCR_MODELS[number])) {
  throw new Error(
    `OPENROUTER_MODEL="${OCR_MODEL}" is not in the approved OCR model whitelist ` +
    `(${APPROVED_OCR_MODELS.join(', ')}). Refusing to start — update APPROVED_OCR_MODELS ` +
    `in app/api/receipts/ocr/route.ts if this model has been vetted.`
  )
}

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}

/*
 * Every line item is returned as its own object with desc, qty, unit, total,
 * is_bud_light and confidence, so the response length scales with the receipt, not
 * with the amount claimed. This was 1024, which is about twelve line items.
 *
 * A real grocery receipt broke it on 2026-08-26: 22 items, mostly deposits and
 * groceries around a few Bud Light lines. The model was cut off mid-JSON, JSON.parse
 * failed, and the student saw "OCR returned invalid JSON" with no amount. Nothing in
 * the message said the output had been truncated, so it read as an unreadable photo
 * when the photo was fine.
 *
 * The people this hits are exactly the ones doing the normal thing: buying beer as
 * part of a weekly shop. 8192 covers a receipt several times longer than that one,
 * and the response is billed on what is actually generated, so a short receipt costs
 * no more than it did before.
 */
const OCR_MAX_TOKENS = 8192

async function callOpenRouter(apiKey: string, base64: string, mediaType: MediaType): Promise<string> {
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OCR_MODEL,
      max_tokens: OCR_MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
          { type: 'text', text: RECEIPT_PROMPT }
        ]
      }]
    })
  })

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`OpenRouter ${resp.status}: ${err}`)
  }

  const json = await resp.json()
  const choice = json.choices?.[0]

  // A truncated response is not a bad receipt, and it must not be reported as one.
  // Without this the caller only sees JSON.parse fail and says "OCR returned invalid
  // JSON", which points the reviewer at the photo instead of at the token ceiling.
  const finish = choice?.finish_reason ?? choice?.native_finish_reason
  if (finish === 'length') {
    throw new Error(
      `the model ran out of room before it finished reading this receipt ` +
      `(stopped at the ${OCR_MAX_TOKENS}-token ceiling). The image is probably fine; ` +
      `this is a very long receipt. Raise OCR_MAX_TOKENS or enter the amount by hand.`
    )
  }

  return choice?.message?.content ?? ''
}

export async function POST(req: Request) {
  // P1-18: both sides are sanitized before comparison. lib/ocr-trigger.ts already
  // strips invisibles from the value it sends, so an unsanitized comparison here
  // meant a single BOM in INTERNAL_API_SECRET would 401 every OCR call while the
  // env var looked correct in the Vercel dashboard. Same for a header that picked
  // up whitespace in transit.
  const internalSecret = cleanEnvValue(process.env.INTERNAL_API_SECRET)
  if (internalSecret) {
    const authHeader = cleanEnvValue(req.headers.get('x-internal-secret'))
    if (authHeader !== internalSecret) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    }
  } else if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ ok: false, error: 'INTERNAL_API_SECRET not configured' }, { status: 500 })
  }

  const body = await req.json()
  const { receipt_id, storage_key } = body as { receipt_id: string; storage_key: string }

  if (!receipt_id || !storage_key) {
    return NextResponse.json({ ok: false, error: 'receipt_id and storage_key required' }, { status: 400 })
  }

  const db = adminClient()

  // 0. Claim the receipt (P1-13): record that OCR actually began. Diagnostic only —
  //    the sweeper keys off status + ocr_queued_at — so a failure here is logged but
  //    must not block OCR (e.g. before migration 0017 is applied). The decisive write
  //    at step 10 is error-checked and read back.
  const { error: claimErr } = await db.from('receipts')
    .update({ ocr_started_at: new Date().toISOString() })
    .eq('id', receipt_id)
  if (claimErr) {
    console.error('[ocr] could not stamp ocr_started_at for', receipt_id, '-', claimErr.message,
      '- has migration 0017_receipt_ai_fixes.sql been applied?')
  }

  // 1. Download image from Storage
  const { data: file, error: dlErr } = await db.storage.from('receipts').download(storage_key)
  if (dlErr || !file) {
    await bumpAttempt(db, receipt_id, `download failed: ${dlErr?.message}`)
    return NextResponse.json({ ok: false, error: `download failed: ${dlErr?.message}` }, { status: 500 })
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const base64 = Buffer.from(bytes).toString('base64')
  const mediaType = (file.type || 'image/jpeg') as MediaType

  // 1b. EXIF check (before OCR — operates on raw bytes)
  const fraudFlags: string[] = checkExif(bytes, mediaType)

  // 2. Call vision model via OpenRouter
  const openrouterKey = process.env.OPENROUTER_API_KEY
  if (!openrouterKey) {
    await bumpAttempt(db, receipt_id, 'OPENROUTER_API_KEY not configured')
    return NextResponse.json({ ok: false, error: 'OPENROUTER_API_KEY not configured' }, { status: 500 })
  }

  let text = ''
  try {
    text = await callOpenRouter(openrouterKey, base64, mediaType)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'vision call failed'
    await bumpAttempt(db, receipt_id, msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }

  // 3. Parse JSON
  let ocr: Record<string, unknown>
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()
    ocr = JSON.parse(cleaned)
  } catch {
    await bumpAttempt(db, receipt_id, 'json parse failed')
    return NextResponse.json({ ok: false, error: 'OCR returned invalid JSON' }, { status: 500 })
  }

  // 4. Fetch receipt row (bam_id/cohort_id/period) — needed for policy + spendableCap + duplicate detection.
  //    P0-H: if this read fails we must NOT continue with default policy/cap — that is
  //    how a $150 payout gets decided for a cohort we could not read.
  const { data: thisReceipt, error: receiptErr } = await db.from('receipts')
    .select('bam_id, cohort_id, period, sha256, late_submission').eq('id', receipt_id).maybeSingle()
  if (receiptErr) {
    await bumpAttempt(db, receipt_id, `receipt lookup failed: ${receiptErr.message}`)
    return NextResponse.json({ ok: false, error: `receipt lookup failed: ${receiptErr.message}` }, { status: 500 })
  }
  if (!thisReceipt) {
    return NextResponse.json({ ok: false, error: 'receipt not found' }, { status: 404 })
  }

  // Server-side recompute of the Bud Light amount (P0-F). Used for the balance
  // fraud gates below and recomputed identically inside classifyReceipt.
  const recomputed = recomputeBudLightTotal(ocr as unknown as OcrResult)

  const confidence = (ocr.overall_confidence as number) ?? 0

  // 5. Content-based duplicate detection + historical pattern analysis (same-BAM signal;
  //    closest available proxy for classifyReceipt's cross-BAM `duplicateHash` input)
  let dupSuspect = false
  const ocrStore = ((ocr.store as string) ?? '').toLowerCase().trim()
  const ocrDate = (ocr.date as string) ?? ''
  const ocrTotal = ocr.grand_total as number | undefined
  let balanceAvailable = 0
  let balanceCap = 0

  if (thisReceipt?.bam_id) {
    // P1-23: balance is scoped to the receipt's PERIOD (the month the spend is
    // claimed for), not the upload timestamp's month.
    const balance = await getMonthlyBalance(db, thisReceipt.bam_id, thisReceipt.period)
    balanceAvailable = balance.available
    // The month's full cap, so over_balance can tell "over the cap" apart from "over what
    // is left". spendableCap further down is resolved too late to use here.
    balanceCap = balance.cap
    if (!balance.ok) {
      // Fail closed: an unknown balance must not look like a full, unused cap.
      balanceAvailable = 0
      fraudFlags.push(`balance_unknown: could not compute this BAM's remaining allowance (${balance.error ?? 'unknown error'}) -- admin must confirm`)
    }

    if (ocrStore && ocrDate && ocrTotal != null) {
      const { data: others, error: othersErr } = await db.from('receipts')
        .select('id, ocr_json')
        .eq('bam_id', thisReceipt.bam_id)
        .neq('id', receipt_id)
        .not('ocr_json', 'is', null)

      if (othersErr) {
        // Duplicate detection could not run — say so instead of implying "no duplicates".
        fraudFlags.push(`duplicate_check_unavailable: prior receipts could not be read (${othersErr.message}) -- admin must confirm`)
      }

      if (others && others.length > 0) {
        for (const other of others) {
          const oj = other.ocr_json as Record<string, unknown> | null
          if (!oj) continue
          const otherStore = ((oj.store as string) ?? '').toLowerCase().trim()
          const otherDate = (oj.date as string) ?? ''
          const otherTotal = oj.grand_total as number | undefined
          if (otherStore === ocrStore && otherDate === ocrDate && otherTotal === ocrTotal) {
            dupSuspect = true
            fraudFlags.push(`duplicate: same store/date/total as receipt ${other.id}`)
            break
          }
        }
        fraudFlags.push(...checkHistoricalPatterns(
          ocr,
          others as Array<{ ocr_json: Record<string, unknown> | null }>,
          balanceAvailable,
          recomputed.total,
          { corroborated: recomputed.matchesPrintedTotal, capCad: balanceCap }
        ))
      }
    }
  }

  /*
   * 5b. HAS SOMEBODY ELSE ALREADY CLAIMED THIS RECEIPT?
   *
   * Everything above this point compares the uploader against the uploader. So does the
   * sha256 check in app/api/portal/upload. Nothing looked across people, so one photo
   * forwarded to a friend paid twice, and lib/classify-receipt's `duplicateHash` input,
   * documented since it was written as "same sha256 already accepted for ANOTHER bam",
   * has only ever been handed a same-BAM answer.
   *
   * Test accounts are excluded in both directions: a test uploader is not checked at
   * all, and no test account's receipt is ever a candidate. A room of testers passing
   * one receipt around must not fill the review queue, and a real BAM must never be
   * accused because a demo receipt is sitting in the same table.
   */
  if (thisReceipt?.bam_id) {
    const { data: uploader, error: uploaderErr } = await db.from('bams')
      .select('is_test').eq('id', thisReceipt.bam_id).maybeSingle()

    if (uploaderErr) {
      // Fail loud, not open. "We could not tell whether to check" is not "no duplicate".
      fraudFlags.push(`duplicate_check_unavailable: could not tell whether this is a test account (${uploaderErr.message}) -- admin must confirm`)
    } else if (uploader?.is_test) {
      console.info('[ocr] cross-BAM duplicate check skipped for test account', thisReceipt.bam_id)
    } else {
      const { data: testBams, error: testErr } = await db.from('bams')
        .select('id').eq('is_test', true)
      const { data: realBams, error: realErr } = await db.from('bams')
        .select('id, first_name, last_name')

      // A period filter is deliberately absent. Reusing a receipt is worth seeing
      // whenever it happens, not only inside one month.
      const { data: theirs, error: theirsErr } = await db.from('receipts')
        .select('id, bam_id, period, sha256, ocr_json')
        .neq('bam_id', thisReceipt.bam_id)
        .neq('status', 'rejected')

      if (testErr || realErr || theirsErr) {
        const why = testErr?.message ?? realErr?.message ?? theirsErr?.message
        fraudFlags.push(`duplicate_check_unavailable: other BAMs' receipts could not be read (${why}) -- admin must confirm`)
      } else {
        const testIds = new Set((testBams ?? []).map((b: { id: string }) => b.id))
        const nameOf = new Map(
          (realBams ?? []).map((b: { id: string; first_name: string; last_name: string }) =>
            [b.id, `${b.first_name} ${b.last_name}`.trim()])
        )

        const { findCrossBamDuplicate } = await import('@/lib/duplicate-receipt')
        const match = findCrossBamDuplicate(
          {
            receiptId: receipt_id,
            bamId: thisReceipt.bam_id,
            sha256: (thisReceipt as { sha256?: string | null }).sha256,
            store: (ocr.store as string) ?? null,
            date: (ocr.date as string) ?? null,
            grandTotal: (ocr.grand_total as number) ?? null
          },
          (theirs ?? [])
            .filter((r: { bam_id: string }) => !testIds.has(r.bam_id))
            .map((r: { id: string; bam_id: string; period: string; sha256: string | null; ocr_json: Record<string, unknown> | null }) => ({
              id: r.id,
              bamId: r.bam_id,
              bamName: nameOf.get(r.bam_id) ?? null,
              period: r.period,
              sha256: r.sha256,
              store: (r.ocr_json?.store as string) ?? null,
              date: (r.ocr_json?.date as string) ?? null,
              grandTotal: (r.ocr_json?.grand_total as number) ?? null
            }))
        )

        if (match) {
          dupSuspect = true
          fraudFlags.push(match.reason)
        }
      }
    }
  }

  // 6. OCR pattern + price checks (on parsed JSON)
  /*
   * `mixedLines` is the server's own recount, not the model's word for it: a bar bill
   * only needs a human when something on it is not Bud Light.
   */
  const mixedLines = recomputeBudLightTotal(ocr as Parameters<typeof recomputeBudLightTotal>[0]).nonBudLightLineCount > 0
  fraudFlags.push(...checkOcrPatterns(ocr, mixedLines))

  // 7. Cohort policy + spendable cap.
  //    P0-G: the cohort's real first_cohort_all_review is passed through. It used to be
  //    SELECTed and then immediately overwritten with `false`, which disabled touchpoint 1.
  //    P0-H: every read here is error-checked; an unreadable cohort must not silently
  //    become "default policy, auto-pass allowed".
  let policy = { ...DEFAULT_POLICY }
  let spendableCap = DEFAULT_POLICY.reimbursementMax
  if (thisReceipt?.cohort_id) {
    const { data: cohort, error: cohortErr } = await db.from('cohorts')
      .select('reimbursement_max, first_cohort_all_review')
      .eq('id', thisReceipt.cohort_id).maybeSingle()
    if (cohortErr || !cohort) {
      // Fail closed: keep DEFAULT_POLICY (firstCohortAllReview = true) so this
      // receipt goes to Robin rather than auto-passing against an unknown cap.
      fraudFlags.push(`cohort_unreadable: could not load cohort policy (${cohortErr?.message ?? 'no cohort row'}) -- admin must confirm`)
    } else {
      const max = parseNonNegativeMoney(cohort.reimbursement_max)
      if (max === null || max <= 0) {
        fraudFlags.push(`cohort_cap_invalid: cohort reimbursement_max is "${String(cohort.reimbursement_max)}" -- admin must confirm`)
      }
      policy = {
        ...policy,
        reimbursementMax: max ?? policy.reimbursementMax,
        firstCohortAllReview: cohort.first_cohort_all_review !== false
      }
    }
  }
  spendableCap = policy.reimbursementMax
  if (thisReceipt?.bam_id) {
    // Rollover is 'forfeit' for every cohort (Robin 2026-08-04), so the ledger's
    // spendable_cap equals the entitlement. Read THIS period's row only — ordering
    // by period desc could pick up a different month's cap.
    const { data: ledgerRow, error: ledgerErr } = await db.from('reimbursement_ledger')
      .select('spendable_cap_cad')
      .eq('bam_id', thisReceipt.bam_id)
      .eq('period', thisReceipt.period)
      .maybeSingle()
    if (ledgerErr) {
      fraudFlags.push(`ledger_unreadable: could not read this period's ledger row (${ledgerErr.message}) -- admin must confirm`)
    } else {
      const cap = parseNonNegativeMoney(ledgerRow?.spendable_cap_cad)
      if (cap !== null && cap > 0) spendableCap = cap
    }
  }

  // 8. Low-resolution heuristic — format-based checks removed (real receipts come in all formats)
  const lowResolutionHeuristic = false

  // 9. Classify via the shared pure function (single source of truth for auto_pass/review/rejected)
  const classification = classifyReceipt({
    ocr: ocr as unknown as OcrResult,
    spendableCap,
    policy,
    duplicateHash: dupSuspect,
    lowResolutionHeuristic,
    lateSubmission: thisReceipt?.late_submission === true
  })

  // Any additional fraud flags (price outliers, tax mismatch, historical patterns, etc.)
  // force review even if classifyReceipt would otherwise auto_pass — they never downgrade
  // an already-rejected result.
  const finalStatus = classification.status === 'rejected'
    ? 'rejected'
    : (fraudFlags.length > 0 ? 'review' : classification.status)
  const decisionReason = fraudFlags.length > 0
    ? [classification.reason, ...fraudFlags].join(' | ')
    : classification.reason

  // 10. Persist OCR result + final classification.
  //     P0-F: bud_light_total_incl_tax is the SERVER-RECOMPUTED amount from the line
  //     items, never ocr.bud_light_total_incl_tax. The model's own figure is kept in
  //     ambiguous_flags so Robin can see the discrepancy she is being asked about.
  const audit = {
    recompute: {
      server_total: classification.budLightTotalInclTax,
      model_total: classification.modelReportedTotal,
      basis: classification.recomputeBasis,
      notes: classification.recomputeNotes
    },
    fraud_flags: fraudFlags,
    spendable_cap: spendableCap,
    policy: {
      reimbursement_max: policy.reimbursementMax,
      review_band_padding_cad: policy.reviewBandPaddingCad,
      first_cohort_all_review: policy.firstCohortAllReview
    }
  }

  /*
   * `.eq('status', 'pending')` is the fix, not the read-back below. This call runs
   * async (triggerOcr schedules it after the upload response is already sent), and
   * an admin can approve or reject straight from the queue while a receipt is still
   * 'pending' -- the UI never hid that button behind OCR finishing. Without the
   * status guard, this write landed unconditionally and clobbered a human decision:
   * measured live 2026-09-16, an admin approved Elle Edwards' receipt at a corrected
   * $144.55 while this route was still mid-flight, and the late write here reset it
   * to 'review' at the original $154.04 -- decided_by/decided_at stayed stamped from
   * the approval (this update never touches them), so the row looked decided and
   * undecided at once, and the approval survived only in audit_log.
   */
  const { data: saved, error: upErr } = await db.from('receipts').update({
    ocr_json: ocr,
    status: finalStatus,
    bud_light_total_incl_tax: classification.budLightTotalInclTax,
    confidence,
    decision_reason: decisionReason,
    ambiguous_flags: audit
  }).eq('id', receipt_id).eq('status', 'pending').select('id, status, bud_light_total_incl_tax')

  if (upErr) {
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 })
  }
  // Zero rows here means the guard did its job, not that anything failed: a human
  // decided first, and their decision wins over a classification that is now moot.
  if (!saved || saved.length === 0) {
    return NextResponse.json({ ok: true, skipped: 'already decided by an admin before OCR finished' })
  }
  // Read-back (ENGINEERING-RULES §1): more than the one row this query can ever match
  // would mean `id` stopped being unique, which is a schema invariant broken, not a
  // race -- keep this as a hard error.
  if (saved.length !== 1) {
    return NextResponse.json(
      { ok: false, error: `classification write affected ${saved.length} rows, expected 1` },
      { status: 500 }
    )
  }

  /*
   * 10b. AN AUTO-PASS IS A DECISION, SO IT HAS TO SETTLE THE MONEY.
   *
   * reimbursement_ledger.paid_cad is the only figure the dashboard and the invoice
   * read. It used to be written only by an admin decision or by the monthly sweep,
   * and an auto-passed receipt goes through neither. The result, seen live on
   * 2026-08-26: a $69.00 auto-passed receipt, no ledger row, a dashboard reading $0,
   * and no invoice, because lib/draft-invoice correctly refuses to invoice a period
   * whose money has not been computed rather than invent an amount.
   *
   * Run inline rather than in after(): the status this route returns has to be the
   * status the receipt ended up in, and the failure branch below changes it.
   *
   * Failure is CLOSED. An auto_pass with no ledger row is exactly the broken state
   * this fixes, so if the ledger cannot be written the receipt goes to the review
   * queue and a human decides. Quietly leaving it auto-passed would reintroduce the
   * bug one row at a time.
   */
  let settledStatus = finalStatus
  let ledgerPaidCad: number | null = null
  let ledgerError: string | undefined

  if (finalStatus === 'auto_pass' && thisReceipt?.bam_id && thisReceipt?.cohort_id && thisReceipt?.period) {
    const { recomputeLedgerForPeriod } = await import('@/lib/recompute-ledger')
    const ledger = await recomputeLedgerForPeriod(db, {
      bamId: thisReceipt.bam_id,
      cohortId: thisReceipt.cohort_id,
      period: thisReceipt.period
    })

    if (ledger.ok) {
      ledgerPaidCad = ledger.paidCad

      /*
       * The same month that settles has to be measured against the floor, or the
       * reevaluate rule quietly skips everyone whose receipts auto-pass. A $69 receipt
       * approved by hand records a warning; the identical receipt auto-passed recorded
       * nothing, so "two consecutive shortfalls" could never trigger for a student the
       * classifier was happy with. That is the wrong way round.
       *
       * No email, matching the decide path: the row and the in-app notification are the
       * record, and /admin/warnings is where a human sends anything.
       */
      if (ledger.belowWarnFloor) {
        scheduleBackground(async () => {
          try {
            const { flagShortfall } = await import('@/lib/shortfall-warning')
            const flag = await flagShortfall(db, {
              bamId: thisReceipt.bam_id,
              cohortId: thisReceipt.cohort_id,
              period: thisReceipt.period,
              spent: ledger.spentCad,
              notes: 'auto-passed receipt, no admin decision'
            }, { sendManagerEmail: false })
            if (!flag.ok) {
              console.error('[ocr] shortfall could not be recorded:', flag.error ?? flag.notifyError)
            }
          } catch (e) {
            console.error('[ocr] flagShortfall failed:', e)
          }
        })
      } else {
        // The mirror image of the block above: this receipt brought the period back
        // past the floor. If an earlier, never-sent warning is sitting on this same
        // period (the first receipt of the month was light, a later one caught it up),
        // clear it -- otherwise the dashboard keeps showing "warned" for a month that
        // ended fine. See resolveCaughtUpShortfall for why only an unsent row moves.
        scheduleBackground(async () => {
          try {
            const { resolveCaughtUpShortfall } = await import('@/lib/shortfall-warning')
            const resolved = await resolveCaughtUpShortfall(db, {
              bamId: thisReceipt.bam_id,
              cohortId: thisReceipt.cohort_id,
              period: thisReceipt.period
            })
            if (!resolved.ok) {
              console.error('[ocr] could not clear caught-up shortfall:', resolved.error)
            }
          } catch (e) {
            console.error('[ocr] resolveCaughtUpShortfall failed:', e)
          }
        })
      }
    } else {
      ledgerError = ledger.error
      console.error('[ocr] ledger write failed for auto-passed receipt', receipt_id, '-', ledger.error)

      const { data: reverted, error: revertErr } = await db.from('receipts').update({
        status: 'review',
        decision_reason:
          `${decisionReason} | auto-pass held for review: the reimbursement could not be recorded (${ledger.error})`
            .slice(0, 1000)
      }).eq('id', receipt_id).select('id, status')

      // Read-back. If even the hold fails, say so loudly: the row is then auto_pass
      // with no money behind it, which is the one state nobody should discover later.
      if (revertErr || reverted?.length !== 1 || reverted[0].status !== 'review') {
        console.error('[ocr] COULD NOT HOLD receipt', receipt_id,
          'for review after a ledger failure -', revertErr?.message ?? `rows=${reverted?.length ?? 0}`,
          '- this receipt is auto-passed with no ledger row and needs a manual check')
      } else {
        settledStatus = 'review'
      }
    }
  }

  // 11. Auto-upsert draft invoice for this BAM+period.
  //     Scheduled with after() so the platform keeps the invocation alive instead of
  //     dropping the promise at response time (same class of bug as P1-13).
  if (thisReceipt?.bam_id && thisReceipt?.cohort_id && thisReceipt?.period) {
    // On an auto-pass the ledger was just written above, so "no ledger row yet" is no
    // longer an expected state on this path and a block here is a real block worth
    // hearing about. Everywhere else it stays quiet, for the reason below.
    const ledgerJustWritten = ledgerPaidCad !== null
    scheduleBackground(async () => {
      try {
        const { upsertDraftInvoice } = await import('@/lib/draft-invoice')
        // F5: quietWhenLedgerPending. For a receipt that lands in `review`, the ledger
        // is written later by receipts/decide or by scheduler-audit, so on that path
        // "no ledger row yet" is the expected state, not an incident. Without this flag
        // every upload fired a false "Invoice generation blocked" notification. Every
        // other block (missing banking, missing PO, cross-cohort, insert failure) stays
        // loud, on both paths.
        await upsertDraftInvoice(db, thisReceipt.bam_id, thisReceipt.cohort_id, thisReceipt.period, {
          quietWhenLedgerPending: !ledgerJustWritten
        })
      } catch (e) {
        console.error('[ocr] draft invoice upsert failed:', e)
      }
    })
  }

  // 12. Admin notification for review
  if (settledStatus === 'review') {
    scheduleBackground(async () => {
      try {
        const { notifyAdmin } = await import('@/lib/notify-admin')
        /*
         * No "BAM 6e93581e:" prefix any more. The row already carries bam_id and the bell
         * resolves it to a name, so the id was a raw UUID eating the front of every
         * preview, exactly where the reason should be.
         */
        await notifyAdmin({
          type: 'receipt_review',
          title: ledgerError ? 'Auto-passed receipt held for review' : 'Receipt needs review',
          body: ledgerError
            ? `The receipt passed every check, but its reimbursement could not be recorded (${ledgerError}), so it is waiting on a decision instead of being paid.`
            : decisionReason,
          bam_id: thisReceipt?.bam_id,
          cohort_id: thisReceipt?.cohort_id,
          period: thisReceipt?.period,
          link: '/admin/receipts'
        })
      } catch (e) {
        console.error('[ocr] notifyAdmin failed:', e)
      }
    })
  }

  /*
   * A read that worked closes the notification about a read that did not.
   *
   * A retry succeeding used to leave "Receipt OCR did not run" unread forever, because
   * nothing anywhere marked a notification done. syncAdminNotifications only closes what
   * is genuinely finished: it looks at whether any of this BAM's receipts for the month
   * are still in that state first.
   */
  if (thisReceipt?.bam_id && thisReceipt?.period) {
    scheduleBackground(async () => {
      try {
        const { syncAdminNotifications } = await import('@/lib/notify-admin')
        const out = await syncAdminNotifications(db, {
          bamId: thisReceipt.bam_id as string, period: thisReceipt.period as string
        })
        if (!out.ok) console.error('[ocr] notification sync failed:', out.error)
      } catch (e) {
        console.error('[ocr] notification sync threw:', e)
      }
    })
  }

  return NextResponse.json({
    ok: true,
    // The status the receipt actually ended in. It is not always the classifier's
    // verdict: an auto-pass whose reimbursement could not be recorded is held for
    // review above, and reporting `auto_pass` here would hide that.
    status: settledStatus,
    classified_status: finalStatus,
    duplicate_suspect: dupSuspect,
    fraud_flags: fraudFlags,
    // surfaced so a caller (and the dry-run harness) can diff amounts without a DB read
    server_total: classification.budLightTotalInclTax,
    model_total: classification.modelReportedTotal,
    recompute_basis: classification.recomputeBasis,
    // What the month now pays, present only when this call settled it.
    ledger_paid_cad: ledgerPaidCad,
    ...(ledgerError ? { ledger_error: ledgerError } : {})
  })
}

/** after() when inside a request scope, inline otherwise (scripts / tests). */
function scheduleBackground(fn: () => Promise<void>) {
  try {
    after(fn)
  } catch {
    void fn()
  }
}

async function bumpAttempt(db: ReturnType<typeof adminClient>, receiptId: string, reason: string) {
  // P0-H: both reads and writes checked. If we cannot even record the failure the
  // receipt would sit at 'pending' invisibly, so we log loudly for the sweeper.
  const { data: r, error: readErr } = await db.from('receipts')
    .select('ocr_attempts').eq('id', receiptId).maybeSingle()
  if (readErr) console.error('[ocr] bumpAttempt read failed:', readErr.message)
  const attempts = ((r as { ocr_attempts?: number } | null)?.ocr_attempts ?? 0) + 1
  const { error: writeErr } = await db.from('receipts').update({
    status: attempts >= 3 ? 'ocr_failed' : 'pending',
    ocr_attempts: attempts,
    decision_reason: reason
  }).eq('id', receiptId)
  if (writeErr) {
    console.error('[ocr] bumpAttempt write failed:', writeErr.message,
      '- receipt', receiptId, 'will be caught by sweep_stale_ocr_receipts')
  }
}
