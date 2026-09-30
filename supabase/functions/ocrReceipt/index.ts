/**
 * Edge Function: ocrReceipt
 * POST { storage_key: string, bam_id: string, cohort_id: string, period: string, receipt_id: string }
 *
 * 1) Load image bytes from Supabase Storage
 * 2) Call a vision model with the prompt from ARCHITECTURE.md §A.4
 * 3) Parse strict JSON. On failure → status='ocr_failed', increment attempts.
 * 4) Persist ocr_json to receipts row (status left 'pending' for classifyReceipt).
 *
 * Provider: OpenRouter (OPENROUTER_API_KEY). Default model: anthropic/claude-sonnet-4.
 * Override via OPENROUTER_MODEL env var (e.g. google/gemini-2.0-flash-001).
 */
import { serviceClient } from '../_shared/supabase-admin'
import { recomputeBudLightTotal, depositShapedGap, isDepositLine, taxIncludedInLines, type OcrResult } from '../../../lib/classify-receipt'
import { parseConfidence } from '../../../lib/money'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Only these vetted vision models may read receipts — a typo'd or ":free"/"auto"
// env var must fail loudly, never silently route to an unverified model.
const APPROVED_OCR_MODELS = [
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-flash',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4',
] as const

const OCR_MODEL = Deno.env.get('OPENROUTER_MODEL') ?? 'anthropic/claude-sonnet-4'
if (!APPROVED_OCR_MODELS.includes(OCR_MODEL as typeof APPROVED_OCR_MODELS[number])) {
  throw new Error(
    `OPENROUTER_MODEL="${OCR_MODEL}" is not in the approved OCR model whitelist ` +
    `(${APPROVED_OCR_MODELS.join(', ')}). Refusing to start — update APPROVED_OCR_MODELS ` +
    `in supabase/functions/ocrReceipt/index.ts if this model has been vetted.`
  )
}

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

   BEER STORE DISCOUNT/PROMO LINES (always associate with the BL item above):
   - "Best Price 1x6=$16.59" followed by a negative amount (e.g. -$1.35)
     is a volume discount on the preceding BL item — keep both lines,
     mark the discount line is_bud_light=true with a negative total.
   - "6:16.59  -1.35" is the same discount in compact format.
   - DEPOSIT lines ($8.50, $3.60, etc.) are container deposits — mark
     is_bud_light=false. Deposits are excluded from bud_light_total.
   - When multiple BL items appear with interleaved discounts, each
     discount belongs to the item immediately above it.

   NOT Bud Light: Budweiser, Michelob, SVNS Hard 7UP, White Claw, Smirnoff,
   Corona, Blood Brothers Blood Light, Cottage Springs, Coors Seltzer, Palm Bay,
   Twisted Tea, or any non-AB InBev brand.

3) Extract: store, date, subtotal, tax (HST/GST/PST/TPS+TVQ), grand_total.
   For Beer Store receipts: use SUBTOTAL (before deposit), not TOTAL (which
   includes deposit). Deposit is not part of the product spend.
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

type OcrLine = { desc?: string; qty?: number; unit?: number; total?: number; is_bud_light?: boolean; ambiguous?: boolean; confidence?: number; reason?: string }

// ── Fraud detection helpers (zero tokens — pure code logic) ──────────────

function checkExif(bytes: Uint8Array, mediaType: string): string[] {
  const flags: string[] = []
  if (mediaType === 'image/jpeg' || mediaType === 'image/jpg') {
    let hasExif = false
    const scanLimit = Math.min(bytes.length - 1, 65536)
    for (let i = 0; i < scanLimit; i++) {
      if (bytes[i] === 0xFF && bytes[i + 1] === 0xE1) { hasExif = true; break }
    }
    if (!hasExif) flags.push('no_exif: JPEG missing EXIF metadata -- possible screenshot or AI-generated image')
  }
  if (mediaType === 'image/png') {
    flags.push('png_format: receipt is PNG instead of camera JPEG -- possible screenshot or generated image')
  }
  return flags
}

function checkOcrPatterns(ocr: Record<string, unknown>): string[] {
  const flags: string[] = []
  const store = ((ocr.store as string) ?? '').trim()
  const tax = (ocr.tax as number) ?? 0
  const subtotal = (ocr.subtotal as number) ?? 0
  const grandTotal = (ocr.grand_total as number) ?? 0
  const receiptType = (ocr.receipt_type as string) ?? ''

  if (receiptType === 'not_a_receipt')
    flags.push('not_a_receipt: image is not a product receipt (bus ticket, ride receipt, bank notification, etc.)')

  if (!store || store.length < 2) flags.push('no_store: no identifiable store name on receipt')

  if (subtotal > 0 && tax > 0) {
    const rate = tax / subtotal
    if (rate < 0.04 || rate > 0.16)
      flags.push(`unusual_tax: ${(rate * 100).toFixed(1)}% tax rate outside normal Canadian range (5–15%)`)
  }

  if (subtotal > 0 && grandTotal > 0 && tax > 0) {
    const expected = subtotal + tax
    const diff = Math.abs(expected - grandTotal)
    // Same deposit exemption as app/api/receipts/ocr, from the same function, because two
    // copies of a rule disagreeing is how one of them quietly becomes the wrong one.
    if (diff > 2.00 && diff / grandTotal > 0.03 && !depositShapedGap(subtotal, tax, grandTotal) && !taxIncludedInLines(ocr as OcrResult))
      flags.push(`total_mismatch: subtotal($${subtotal.toFixed(2)}) + tax($${tax.toFixed(2)}) = $${expected.toFixed(2)} but grand_total is $${grandTotal.toFixed(2)}`)
  }

  return flags
}

// No price check. See app/api/receipts/ocr/route.ts for why it was removed.

function checkHistoricalPatterns(
  currentOcr: Record<string, unknown>,
  othersOcr: Array<{ ocr_json: Record<string, unknown> | null }>,
  availableBalance: number
): string[] {
  if (othersOcr.length < 2) return []
  const flags: string[] = []
  const blTotal = (currentOcr.bud_light_total_incl_tax as number) ?? 0
  const store = ((currentOcr.store as string) ?? '').toLowerCase().trim()

  const pastBlTotals: number[] = []
  const pastStores: string[] = []
  for (const o of othersOcr) {
    if (!o.ocr_json) continue
    const t = o.ocr_json.bud_light_total_incl_tax as number | undefined
    const s = ((o.ocr_json.store as string) ?? '').toLowerCase().trim()
    if (t != null) pastBlTotals.push(t)
    if (s) pastStores.push(s)
  }

  if (blTotal > availableBalance && availableBalance > 0)
    flags.push(`over_balance: BL total $${blTotal.toFixed(2)} exceeds available balance $${availableBalance.toFixed(2)}`)

  const nearBalance = (v: number) => availableBalance > 0 && Math.abs(v - availableBalance) / availableBalance < 0.07
  const nearCount = pastBlTotals.filter(nearBalance).length + (nearBalance(blTotal) ? 1 : 0)
  if (nearCount >= 3)
    flags.push(`near_balance_pattern: ${nearCount} receipts clustered near available balance ($${availableBalance.toFixed(2)}) -- possible gaming`)

  if (store && pastStores.length >= 5 && pastStores.every(s => s === store))
    flags.push(`same_store_always: all ${pastStores.length + 1} receipts from "${store}" -- unusual variety`)

  return flags
}

const DEFAULT_REIMB_CAP = 150

/**
 * P1-5 (audit 2026-08-07): this filtered on `receipts.created_at`, which does not
 *   exist (the column is `uploaded_at`). PostgREST returned error 42703, only `data`
 *   was destructured, so `used` was always 0 and the returned balance was always the
 *   full cap. That silently disabled the over_balance gate.
 * P1-23: the window is the receipt `period`, matching every other path, not the
 *   upload timestamp's calendar month.
 *
 * Returns null when the balance cannot be determined, so callers fail closed instead
 * of treating an unknown balance as a fully unused cap.
 */
async function getMonthlyBalanceEF(
  db: ReturnType<typeof serviceClient>,
  bamId: string,
  cohortId: string,
  period: string
): Promise<number | null> {
  const m = /^(\d{4})-(\d{2})/.exec(String(period).trim())
  if (!m) {
    console.error('[ocrReceipt] unrecognized period for balance:', period)
    return null
  }
  const periodStart = `${m[1]}-${m[2]}-01`

  const { data: cohort, error: cohortErr } = await db.from('cohorts')
    .select('reimbursement_max').eq('id', cohortId).maybeSingle()
  if (cohortErr) {
    console.error('[ocrReceipt] cohort lookup failed:', cohortErr.message)
    return null
  }
  const capRaw = Number(cohort?.reimbursement_max ?? DEFAULT_REIMB_CAP)
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : DEFAULT_REIMB_CAP

  const { data, error } = await db.from('receipts')
    .select('bud_light_total_incl_tax')
    .eq('bam_id', bamId)
    .eq('period', periodStart)
    .in('status', ['approved', 'auto_pass'])

  if (error) {
    console.error('[ocrReceipt] receipts balance query failed:', error.message)
    return null
  }

  let used = 0
  for (const r of data ?? []) {
    const v = Number((r as { bud_light_total_incl_tax: number | string | null }).bud_light_total_incl_tax ?? 0)
    if (Number.isFinite(v) && v > 0) used += v
  }

  return Math.max(0, Math.round((cap - used) * 100) / 100)
}

type Req = {
  receipt_id: string
  storage_key: string
  bam_id: string
  cohort_id: string
  period: string
}

export async function handler(req: Req): Promise<{
  ok: boolean
  status: string
  error?: string
  fraud_flags?: string[]
  duplicate_suspect?: boolean
  server_total?: number
  model_total?: number | null
}> {
  const db = serviceClient()

  // 1. Load image bytes
  const bucket = db.storage.from('receipts')
  const { data: file, error: dlErr } = await bucket.download(req.storage_key)
  if (dlErr || !file) return await failReceipt(db, req.receipt_id, `download failed: ${dlErr?.message}`)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const base64 = btoa(String.fromCharCode(...bytes))
  const mediaType = (file.type || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

  // 1b. EXIF check (before OCR — operates on raw bytes)
  const fraudFlags: string[] = checkExif(bytes, mediaType)

  // 2. Call vision model via OpenRouter
  const openrouterKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!openrouterKey) {
    return await failReceipt(db, req.receipt_id, 'OPENROUTER_API_KEY not configured')
  }

  let text = ''
  try {
    text = await callOpenRouter(openrouterKey, base64, mediaType)
  } catch (e) {
    return await failReceipt(db, req.receipt_id, `vision call failed: ${(e as Error).message}`)
  }

  // 3. Parse strict JSON
  let ocr: unknown
  try {
    // strip common wrapping (```json ... ```) if the model added it
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()
    ocr = JSON.parse(cleaned)
  } catch {
    return await failReceipt(db, req.receipt_id, 'json parse failed')
  }

  // 4. Persist.
  //    P0-F: the stored amount is the SERVER recompute from the line items, not the
  //    model's bud_light_total_incl_tax field. Any disagreement over $1 forces review.
  const ocrTyped = ocr as Record<string, unknown> & { bud_light_total_incl_tax?: number; overall_confidence?: number; store?: string; date?: string; grand_total?: number }
  const recomputed = recomputeBudLightTotal(ocr as unknown as OcrResult)
  if (recomputed.mismatch) {
    const claimed = recomputed.modelTotal === null ? 'an unusable value' : `$${recomputed.modelTotal.toFixed(2)}`
    fraudFlags.push(`total_mismatch: model reported ${claimed} but the line items add up to $${recomputed.total.toFixed(2)} -- using the recomputed amount, admin must confirm`)
  }
  if (recomputed.exceedsGrandTotal) {
    fraudFlags.push(`over_grand_total: Bud Light total $${recomputed.total.toFixed(2)} exceeds the receipt grand total -- admin must confirm`)
  }
  if (recomputed.unparsableLines > 0) {
    fraudFlags.push(`unreadable_amounts: ${recomputed.unparsableLines} line total(s) could not be read as a number -- admin must confirm`)
  }

  const { data: persisted, error: upErr } = await db.from('receipts').update({
    ocr_json: ocr,
    bud_light_total_incl_tax: recomputed.total,
    confidence: parseConfidence(ocrTyped.overall_confidence)
  }).eq('id', req.receipt_id).select('id, bud_light_total_incl_tax')
  if (upErr) return { ok: false, status: 'error', error: upErr.message }
  if (!persisted || persisted.length !== 1) {
    return { ok: false, status: 'error', error: `OCR write affected ${persisted?.length ?? 0} rows, expected 1` }
  }

  // 5. OCR pattern + price checks (on parsed JSON)
  fraudFlags.push(...checkOcrPatterns(ocrTyped))

  // 5b. Date-mismatch check: receipt date should match submission period month
  const ocrDateStr = (ocrTyped.date ?? '') as string
  if (ocrDateStr) {
    const parsed = new Date(ocrDateStr)
    if (!isNaN(parsed.getTime())) {
      const periodDate = new Date(req.period)
      if (!isNaN(periodDate.getTime())) {
        const receiptMonth = parsed.getFullYear() * 12 + parsed.getMonth()
        const periodMonth = periodDate.getFullYear() * 12 + periodDate.getMonth()
        if (receiptMonth !== periodMonth) {
          fraudFlags.push(`date mismatch: receipt dated ${ocrDateStr} but submitted for ${req.period.slice(0, 7)}`)
        }
      }
    }
  }

  // 6. Content-based duplicate detection + historical pattern analysis
  let dupSuspect = false
  const ocrStore = (ocrTyped.store ?? '').toLowerCase().trim()
  const ocrDate = ocrDateStr
  const ocrTotal = ocrTyped.grand_total

  if (ocrStore && ocrDate && ocrTotal != null) {
    const balance = await getMonthlyBalanceEF(db, req.bam_id, req.cohort_id, req.period)
    // Fail closed: an unknown balance must not look like a full, unused cap.
    const availBal = balance ?? 0
    if (balance === null) {
      fraudFlags.push("balance_unknown: could not compute this BAM's remaining allowance -- admin must confirm")
    }

    const { data: others, error: othersErr } = await db.from('receipts')
      .select('id, ocr_json')
      .eq('bam_id', req.bam_id)
      .neq('id', req.receipt_id)
      .not('ocr_json', 'is', null)

    if (othersErr) {
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
      fraudFlags.push(...checkHistoricalPatterns(ocrTyped, others as Array<{ ocr_json: Record<string, unknown> | null }>, availBal))
    }
  }

  // 7. If any fraud flags fired, force review + persist flags
  if (fraudFlags.length > 0) {
    const { data: flagged, error: flagErr } = await db.from('receipts').update({
      status: 'review',
      decision_reason: fraudFlags.join(' | ')
    }).eq('id', req.receipt_id).select('id, status')
    if (flagErr) {
      return { ok: false, status: 'error', error: `could not flag receipt for review: ${flagErr.message}`, fraud_flags: fraudFlags }
    }
    if (!flagged || flagged.length !== 1 || flagged[0].status !== 'review') {
      return { ok: false, status: 'error', error: 'receipt was not moved to review', fraud_flags: fraudFlags }
    }
  }

  return {
    ok: true,
    status: fraudFlags.length > 0 ? 'review' : 'ocr_complete',
    fraud_flags: fraudFlags,
    duplicate_suspect: dupSuspect,
    server_total: recomputed.total,
    model_total: recomputed.modelTotal
  }
}

type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

async function callOpenRouter(apiKey: string, base64: string, mediaType: MediaType): Promise<string> {
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OCR_MODEL,
      max_tokens: 1024,
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
  return json.choices?.[0]?.message?.content ?? ''
}

async function failReceipt(db: ReturnType<typeof serviceClient>, receiptId: string, reason: string) {
  const { data: r, error: readErr } = await db.from('receipts')
    .select('ocr_attempts').eq('id', receiptId).maybeSingle()
  if (readErr) console.error('[ocrReceipt] failReceipt read failed:', readErr.message)
  const attempts = (r?.ocr_attempts ?? 0) + 1
  const { error: writeErr } = await db.from('receipts').update({
    status: attempts >= 3 ? 'ocr_failed' : 'pending',   // retry up to 3 times before giving up
    ocr_attempts: attempts,
    decision_reason: reason
  }).eq('id', receiptId)
  if (writeErr) {
    console.error('[ocrReceipt] failReceipt write failed:', writeErr.message,
      '- receipt', receiptId, 'will be caught by sweep_stale_ocr_receipts')
  }
  return { ok: false, status: attempts >= 3 ? 'ocr_failed' : 'retry', error: reason }
}
