/**
 * Edge Function: ocrReceipt
 * POST { storage_key: string, bam_id: string, cohort_id: string, period: string, receipt_id: string }
 *
 * 1) Load image bytes from Supabase Storage
 * 2) Call Claude Vision (Anthropic) with the prompt from ARCHITECTURE.md §A.4
 * 3) Parse strict JSON. On failure → status='ocr_failed', increment attempts.
 * 4) Persist ocr_json to receipts row (status left 'pending' for classifyReceipt).
 *
 * Note: v1 uses Claude Haiku 4.5 for cost. Dev/testing may swap to Gemini via
 * a feature flag (`LLM_PROVIDER=gemini`).
 */
import Anthropic from '@anthropic-ai/sdk'
import { serviceClient } from '../_shared/supabase-admin'

const RECEIPT_PROMPT = `You are an audit assistant reading a Canadian retail receipt image. Return JSON only.

Task:
1) OCR every line item with: description, unit_price, qty, line_total.
2) Classify each line as bud_light (true/false). "bud_light" = any item whose
   name/brand explicitly matches Bud Light SKUs (Bud Light, Bud Light Lime,
   Bud Light Chelada, Bud Light Platinum, Bud Light Seltzer, and known variants).
   Reject other Anheuser-Busch brands (Budweiser, Michelob) unless the receipt line
   literally contains "Bud Light".
3) Extract: store, date, subtotal, tax (HST/GST/PST), grand_total.
4) Return confidence for each line (0.0–1.0) and overall receipt confidence.
5) Flag ambiguity: if a line could be Bud Light but isn't certain, mark
   {"ambiguous": true, "reason": "..."}.

Return JSON schema:
{ "store": string, "date": string, "currency": string,
  "lines": [{ "desc": string, "qty": number, "unit": number, "total": number,
              "is_bud_light": boolean, "confidence": number,
              "ambiguous"?: boolean, "reason"?: string }],
  "subtotal": number, "tax": number, "grand_total": number,
  "bud_light_total_incl_tax": number, "overall_confidence": number,
  "notes"?: string }

Never invent values. If unreadable, set confidence=0 and add to notes.`

type Req = {
  receipt_id: string
  storage_key: string
  bam_id: string
  cohort_id: string
  period: string
}

export async function handler(req: Req): Promise<{ ok: boolean; status: string; error?: string }> {
  const db = serviceClient()

  // 1. Load image bytes
  const bucket = db.storage.from('receipts')
  const { data: file, error: dlErr } = await bucket.download(req.storage_key)
  if (dlErr || !file) return await failReceipt(db, req.receipt_id, `download failed: ${dlErr?.message}`)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const base64 = btoa(String.fromCharCode(...bytes))
  const mediaType = (file.type || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

  // 2. Call Claude
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return await failReceipt(db, req.receipt_id, 'ANTHROPIC_API_KEY missing')
  const client = new Anthropic({ apiKey })

  let text = ''
  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: RECEIPT_PROMPT }
        ]
      }]
    })
    text = resp.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')
  } catch (e) {
    return await failReceipt(db, req.receipt_id, `claude call failed: ${(e as Error).message}`)
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

  // 4. Persist
  const { error: upErr } = await db.from('receipts').update({
    ocr_json: ocr,
    bud_light_total_incl_tax: (ocr as { bud_light_total_incl_tax?: number }).bud_light_total_incl_tax ?? 0,
    confidence: (ocr as { overall_confidence?: number }).overall_confidence ?? 0
  }).eq('id', req.receipt_id)
  if (upErr) return { ok: false, status: 'error', error: upErr.message }

  return { ok: true, status: 'ocr_complete' }
}

async function failReceipt(db: ReturnType<typeof serviceClient>, receiptId: string, reason: string) {
  const { data: r } = await db.from('receipts').select('ocr_attempts').eq('id', receiptId).single()
  const attempts = (r?.ocr_attempts ?? 0) + 1
  await db.from('receipts').update({
    status: attempts >= 3 ? 'ocr_failed' : 'pending',   // retry up to 3 times before giving up
    ocr_attempts: attempts,
    decision_reason: reason
  }).eq('id', receiptId)
  return { ok: false, status: attempts >= 3 ? 'ocr_failed' : 'retry', error: reason }
}
