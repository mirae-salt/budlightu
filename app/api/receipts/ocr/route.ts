import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getMonthlyBalance } from '@/lib/balance'
import { classifyReceipt, type OcrResult } from '@/lib/classify-receipt'
import { DEFAULT_POLICY } from '@/lib/policy'

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

function checkOcrPatterns(ocr: Record<string, unknown>): string[] {
  const flags: string[] = []
  const store = ((ocr.store as string) ?? '').trim()
  const date = ((ocr.date as string) ?? '').trim()
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
    if (diff > 2.00 && diff / grandTotal > 0.03)
      flags.push(`total_mismatch: subtotal($${subtotal.toFixed(2)}) + tax($${tax.toFixed(2)}) = $${expected.toFixed(2)} but grand_total is $${grandTotal.toFixed(2)}`)
  }

  return flags
}

const BL_UNIT_MIN = 2.00
const BL_UNIT_MAX = 70.00

function checkPriceReasonableness(ocr: Record<string, unknown>): string[] {
  const flags: string[] = []
  const lines = (ocr.lines as OcrLine[]) ?? []

  for (const line of lines) {
    if (!line.is_bud_light) continue
    const total = line.total ?? 0
    const qty = line.qty ?? 1
    const unitPrice = qty > 0 ? total / qty : total
    if (unitPrice > 0 && (unitPrice < BL_UNIT_MIN || unitPrice > BL_UNIT_MAX))
      flags.push(`price_outlier: "${line.desc}" at $${unitPrice.toFixed(2)}/unit outside expected range ($${BL_UNIT_MIN}–$${BL_UNIT_MAX})`)
  }

  return flags
}

function checkHistoricalPatterns(
  currentOcr: Record<string, unknown>,
  othersOcr: Array<{ ocr_json: Record<string, unknown> | null }>,
  availableBalance: number
): string[] {
  if (othersOcr.length < 2) return []
  const flags: string[] = []
  const grandTotal = (currentOcr.grand_total as number) ?? 0
  const store = ((currentOcr.store as string) ?? '').toLowerCase().trim()

  const pastTotals: number[] = []
  const pastStores: string[] = []
  for (const o of othersOcr) {
    if (!o.ocr_json) continue
    const t = o.ocr_json.grand_total as number | undefined
    const s = ((o.ocr_json.store as string) ?? '').toLowerCase().trim()
    if (t != null) pastTotals.push(t)
    if (s) pastStores.push(s)
  }

  if (grandTotal > availableBalance && availableBalance > 0)
    flags.push(`over_balance: receipt $${grandTotal.toFixed(2)} exceeds available balance $${availableBalance.toFixed(2)}`)

  const nearBalance = (v: number) => availableBalance > 0 && Math.abs(v - availableBalance) / availableBalance < 0.07
  const nearCount = pastTotals.filter(nearBalance).length + (nearBalance(grandTotal) ? 1 : 0)
  if (nearCount >= 3)
    flags.push(`near_balance_pattern: ${nearCount} receipts clustered near available balance ($${availableBalance.toFixed(2)}) — possible gaming`)

  if (store && pastStores.length >= 5 && pastStores.every(s => s === store))
    flags.push(`same_store_always: all ${pastStores.length + 1} receipts from "${store}" — unusual variety`)

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

export async function POST(req: Request) {
  const internalSecret = process.env.INTERNAL_API_SECRET
  if (internalSecret) {
    const authHeader = req.headers.get('x-internal-secret')
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

  // 4. Fetch receipt row (bam_id/cohort_id/period) — needed for policy + spendableCap + duplicate detection
  const { data: thisReceipt } = await db.from('receipts')
    .select('bam_id, cohort_id, period').eq('id', receipt_id).single()

  const confidence = (ocr.overall_confidence as number) ?? 0

  // 5. Content-based duplicate detection + historical pattern analysis (same-BAM signal;
  //    closest available proxy for classifyReceipt's cross-BAM `duplicateHash` input)
  let dupSuspect = false
  const ocrStore = ((ocr.store as string) ?? '').toLowerCase().trim()
  const ocrDate = (ocr.date as string) ?? ''
  const ocrTotal = ocr.grand_total as number | undefined
  let balanceAvailable = 0

  if (thisReceipt?.bam_id) {
    const balance = await getMonthlyBalance(db, thisReceipt.bam_id)
    balanceAvailable = balance.available

    if (ocrStore && ocrDate && ocrTotal != null) {
      const { data: others } = await db.from('receipts')
        .select('id, ocr_json')
        .eq('bam_id', thisReceipt.bam_id)
        .neq('id', receipt_id)
        .not('ocr_json', 'is', null)

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
        fraudFlags.push(...checkHistoricalPatterns(ocr, others as Array<{ ocr_json: Record<string, unknown> | null }>, balanceAvailable))
      }
    }
  }

  // 6. OCR pattern + price checks (on parsed JSON)
  fraudFlags.push(...checkOcrPatterns(ocr))
  fraudFlags.push(...checkPriceReasonableness(ocr))

  // 7. Cohort policy + spendable cap (rollover-aware ledger snapshot, falls back to policy default)
  let policy = { ...DEFAULT_POLICY }
  let spendableCap = DEFAULT_POLICY.reimbursementMax
  if (thisReceipt?.cohort_id) {
    const { data: cohort } = await db.from('cohorts')
      .select('reimbursement_max, first_cohort_all_review')
      .eq('id', thisReceipt.cohort_id).single()
    if (cohort) {
      policy = {
        ...policy,
        reimbursementMax: Number(cohort.reimbursement_max ?? policy.reimbursementMax),
        firstCohortAllReview: false
      }
    }
  }
  if (thisReceipt?.bam_id) {
    const { data: latestLedger } = await db.from('reimbursement_ledger')
      .select('spendable_cap_cad')
      .eq('bam_id', thisReceipt.bam_id)
      .order('period', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latestLedger?.spendable_cap_cad != null) {
      spendableCap = Number(latestLedger.spendable_cap_cad)
    } else {
      spendableCap = policy.reimbursementMax
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
    lowResolutionHeuristic
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

  // 10. Persist OCR result + final classification
  const { error: upErr } = await db.from('receipts').update({
    ocr_json: ocr,
    status: finalStatus,
    bud_light_total_incl_tax: classification.budLightTotalInclTax,
    confidence,
    decision_reason: decisionReason
  }).eq('id', receipt_id)

  if (upErr) {
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 })
  }

  // 11. Auto-upsert draft invoice for this BAM+period (fire-and-forget)
  if (thisReceipt?.bam_id && thisReceipt?.cohort_id && thisReceipt?.period) {
    import('@/lib/draft-invoice').then(({ upsertDraftInvoice: upsert }) =>
      upsert(db, thisReceipt.bam_id, thisReceipt.cohort_id, thisReceipt.period)
    ).catch(e => console.error('[ocr] draft invoice upsert failed:', e))
  }

  // 12. Admin notification for review/ocr_failed
  if (finalStatus === 'review') {
    import('@/lib/notify-admin').then(({ notifyAdmin }) => {
      const bamLabel = thisReceipt?.bam_id ? `BAM ${thisReceipt.bam_id.slice(0, 8)}` : 'Unknown BAM'
      notifyAdmin({
        type: 'receipt_review',
        title: 'Receipt needs review',
        body: `${bamLabel}: ${decisionReason}`,
        bam_id: thisReceipt?.bam_id,
        cohort_id: thisReceipt?.cohort_id,
        period: thisReceipt?.period,
        link: '/admin/receipts'
      })
    }).catch(() => {})
  }

  return NextResponse.json({
    ok: true,
    status: finalStatus,
    duplicate_suspect: dupSuspect,
    fraud_flags: fraudFlags
  })
}


async function bumpAttempt(db: ReturnType<typeof adminClient>, receiptId: string, reason: string) {
  const { data: r } = await db.from('receipts').select('ocr_attempts').eq('id', receiptId).single()
  const attempts = ((r as { ocr_attempts?: number } | null)?.ocr_attempts ?? 0) + 1
  await db.from('receipts').update({
    status: attempts >= 3 ? 'ocr_failed' : 'pending',
    ocr_attempts: attempts,
    decision_reason: reason
  }).eq('id', receiptId)
}
