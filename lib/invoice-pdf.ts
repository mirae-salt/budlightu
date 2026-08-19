/**
 * ONE implementation of "get me the PDF bytes for this invoice" (F1, critic gate
 * 2026-08-07).
 *
 * WHAT WAS BROKEN
 * ---------------
 * `invoices.pdf_key` existed as a column (0001:183), as a trigger guard (0004:23)
 * and as a precondition in three places:
 *   supabase/functions/sendApEmail/index.ts        `if (!inv.pdf_key) return ...`
 *   supabase/functions/sendBamCopy/index.ts        same
 *   supabase/functions/archiveToSharePoint/index.ts same
 * ...and NOTHING in the codebase ever wrote it. So touchpoint 2 was inoperable:
 * batch-approve could never reach `if (ap.ok)`, `status` never became 'approved',
 * nothing was ever archived to SharePoint, and BAM copies carried no attachment.
 * Robin selects 58 drafts, clicks Approve, gets 58 failures.
 *
 * WHAT THIS DOES
 * --------------
 * `ensureInvoicePdf` is the single rendering + storage path. Every sender calls
 * it and nobody calls `renderInvoicePdfToBuffer` directly any more:
 *
 *   1. `pdf_key` set and the object downloads  -> return those exact bytes.
 *      Once a document has been archived, AP, SharePoint and the BAM must all
 *      receive the SAME bytes, not three independent re-renders.
 *   2. otherwise -> assertPdfRenderable(payload) (P1-9: report which field and
 *      which character, before react-pdf mangles the exception), render, upload
 *      to the `invoices` bucket, write `pdf_key` back and read it back.
 *
 * Storage is BEST EFFORT on purpose. If the bucket is missing or the write is
 * refused we still return the rendered bytes plus a `warning`, because the money
 * path (AP receives a correct invoice) must not depend on a storage bucket
 * having been provisioned. A render failure, by contrast, is fatal: AP requires
 * 1 PDF per email and we will not send an email with no attachment.
 *
 * 0004's `invoices_system_fields_guard` exempts `service_role`, so the pdf_key
 * write below is permitted. Every caller here uses the service client.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */
import { renderInvoicePdfToBuffer } from './render-pdf'
import { assertPdfRenderable } from './pdf-text'
import type { InvoicePayload } from './invoice-payload'

/** Storage bucket for rendered invoice PDFs (supabase/migrations/0019_invoices_bucket.sql). */
export const INVOICE_PDF_BUCKET = 'invoices'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PdfDbClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (...args: any[]) => any
  storage: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: (bucket: string) => any
  }
}

export type InvoiceForPdf = {
  id: string
  period: string
  invoice_number: string
  pdf_key?: string | null
  payload_json?: unknown
  revision?: number | null
}

export type EnsurePdfResult =
  | {
      ok: true
      /**
       * Explicitly `Uint8Array<ArrayBuffer>`, not the default
       * `Uint8Array<ArrayBufferLike>`: a SharedArrayBuffer-backed view is not a
       * valid `fetch` BodyInit, and archiveToSharePoint PUTs these bytes directly.
       */
      bytes: Uint8Array<ArrayBuffer>
      filename: string
      /** Storage key, null when the object could not be persisted (see `warning`). */
      pdfKey: string | null
      /** true when this call rendered + uploaded rather than reusing a stored object. */
      rendered: boolean
      /** Non-fatal problem: the PDF is usable but was not archived to Storage. */
      warning?: string
    }
  | { ok: false; error: string }

/**
 * Deterministic storage key: `<YYYY-MM>/<INV-NUMBER>.pdf`.
 * invoice_number is already constrained to `INV-[A-Z]+<seq>(-R<rev>)?` by
 * lib/invoice-numbering, so there is nothing here to escape. No BAM name is used
 * (a non-ASCII name in a storage key is the same class of trap as P1-16).
 */
export function invoicePdfStorageKey(inv: Pick<InvoiceForPdf, 'period' | 'invoice_number'>): string {
  const month = String(inv.period).slice(0, 7)
  return `${month}/${inv.invoice_number}.pdf`
}

export async function ensureInvoicePdf(
  db: PdfDbClient,
  inv: InvoiceForPdf,
  filename: string
): Promise<EnsurePdfResult> {
  // ── 1. reuse the archived document when there is one ──────────────────────
  if (inv.pdf_key) {
    const { data: stored, error: dlErr } = await db.storage.from(INVOICE_PDF_BUCKET).download(inv.pdf_key)
    if (!dlErr && stored) {
      return {
        ok: true,
        bytes: new Uint8Array(await stored.arrayBuffer()),
        filename,
        pdfKey: inv.pdf_key,
        rendered: false
      }
    }
    // pdf_key points at nothing. Re-render rather than blocking the send, but say so.
    console.error(
      `[invoice-pdf] invoice ${inv.id} has pdf_key="${inv.pdf_key}" but the object could not be downloaded ` +
      `(${dlErr?.message ?? 'no data'}). Re-rendering from payload_json.`
    )
  }

  // ── 2. render from payload_json ───────────────────────────────────────────
  const payload = inv.payload_json
  if (!payload || typeof payload !== 'object' || !('invoiceNumber' in (payload as object))) {
    return { ok: false, error: 'invoice has no usable payload_json — regenerate the invoice before sending' }
  }

  let bytes: Uint8Array<ArrayBuffer>
  try {
    assertPdfRenderable(payload)
    const buffer = await renderInvoicePdfToBuffer(payload as unknown as InvoicePayload)
    bytes = new Uint8Array(buffer)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[invoice-pdf] render failed for invoice ${inv.id}:`, msg)
    return { ok: false, error: `PDF render failed: ${msg}` }
  }

  // ── 3. archive it and record pdf_key (best effort) ────────────────────────
  const key = invoicePdfStorageKey(inv)
  const { error: upErr } = await db.storage
    .from(INVOICE_PDF_BUCKET)
    .upload(key, bytes, { contentType: 'application/pdf', upsert: true })

  if (upErr) {
    return {
      ok: true,
      bytes,
      filename,
      pdfKey: null,
      rendered: true,
      warning:
        `PDF rendered but NOT archived to Storage: ${upErr.message}. ` +
        `Has supabase/migrations/0019_invoices_bucket.sql been applied?`
    }
  }

  // Read-back (ENGINEERING-RULES section 1): an update that matched 0 rows is
  // not a success, and a swallowed error here is what made pdf_key look written.
  const { data: updated, error: keyErr } = await db
    .from('invoices')
    .update({ pdf_key: key })
    .eq('id', inv.id)
    .select('id, pdf_key')

  if (keyErr) {
    return {
      ok: true,
      bytes,
      filename,
      pdfKey: null,
      rendered: true,
      warning: `PDF archived at ${key} but invoices.pdf_key could not be recorded: ${keyErr.message}`
    }
  }
  const savedKey = (updated ?? [])[0]?.pdf_key
  if (savedKey !== key) {
    return {
      ok: true,
      bytes,
      filename,
      pdfKey: null,
      rendered: true,
      warning: `PDF archived at ${key} but invoices.pdf_key read back as ${JSON.stringify(savedKey)}`
    }
  }

  return { ok: true, bytes, filename, pdfKey: key, rendered: true }
}

/**
 * Base64 for Microsoft Graph fileAttachment (F16).
 *
 * `btoa(String.fromCharCode(...bytes))` spreads every byte as a function
 * argument and throws `RangeError: Maximum call stack size exceeded` somewhere
 * around 100 KB. A real invoice PDF is bigger than that, so the AP send would
 * have thrown on the very first live attempt. Chunked, no spread.
 */
export function bytesToBase64(bytes: Uint8Array<ArrayBufferLike>): string {
  // Node (Next.js route / vitest) has Buffer and does this in one pass.
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')

  // Deno / Edge runtime: chunk so no single call gets 100k+ arguments.
  const CHUNK = 0x8000 // 32 KB per chunk, well inside the argument limit
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[])
  }
  return btoa(binary)
}
