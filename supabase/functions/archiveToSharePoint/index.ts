/**
 * Edge Function: archiveToSharePoint
 * POST { invoice_id: string }
 *
 * Uploads the invoice PDF into SharePoint archive:
 *   /Sites/CampusBAM/Invoices/{Cohort}/{YYYY-MM}/{filename}.pdf
 *
 * Auto-creates the folder tree. Uses PUT with @microsoft.graph.conflictBehavior=replace
 * so re-runs are idempotent (same key overwrites the same file).
 */
import { serviceClient } from '../_shared/supabase-admin'
import { invoicePdfFilename } from '../../../lib/invoice-numbering'
import { slugifySegment, cleanText } from '../../../lib/sanitize'
import { ensureInvoicePdf } from '../../../lib/invoice-pdf'

const SITE_HOST = 'ilovesalt.sharepoint.com'
const SITE_PATH = '/sites/Labatt'
const DRIVE_PATH_ROOT = 'CampusBAM/Invoices'  // library path

/**
 * P1-18: env values are sanitized before they reach a URL. A BOM in
 * MS_TENANT_ID becomes `%EF%BB%BF` in the token endpoint path and 404s with no
 * visible cause. Same class as the incident that triggered the audit.
 * Works under both Node (Next.js route calling `handler`) and Deno (Edge).
 */
function msEnv(name: string): string | null {
  const raw =
    (typeof process !== 'undefined' ? process.env?.[name] : undefined) ??
    Deno?.env?.get?.(name)
  if (raw === undefined || raw === null) return null
  const clean = cleanText(String(raw))
  return clean || null
}

export async function handler(req: { invoice_id: string }) {
  const db = serviceClient()

  const { data: inv, error } = await db.from('invoices').select('*, bams(*), cohorts(*)').eq('id', req.invoice_id).single()
  if (error || !inv) return { ok: false, error: `invoice not found: ${error?.message}` }

  const bam = (inv as any).bams
  const cohort = (inv as any).cohorts
  const period = new Date(inv.period)
  const yyyy = period.getUTCFullYear()
  const mm = String(period.getUTCMonth() + 1).padStart(2, '0')
  // P1-27: `cohort.name.replace(/\s+/g, '-')` did NOT remove U+FEFF and friends,
  // so an invisible character in the cohort name produced a SECOND, visually
  // identical archive folder and split the audit trail across both. slugifySegment
  // strips invisibles first, then folds whitespace and characters SharePoint
  // rejects.
  const cohortSlug = slugifySegment(String(cohort?.name ?? ''))
  if (!cohortSlug) {
    return { ok: false, error: 'cohort name is empty or contains no usable characters; refusing to archive to an unnamed folder' }
  }
  const filename = invoicePdfFilename(bam.first_name, bam.last_name, period, inv.invoice_number)

  // F1: `if (!inv.pdf_key) return 'pdf not rendered yet'` could never pass —
  // nothing in the codebase wrote pdf_key, so nothing was ever archived. Shared
  // render+archive path; reuses the stored object when there is one.
  const pdf = await ensureInvoicePdf(db, {
    id: inv.id,
    period: inv.period,
    invoice_number: inv.invoice_number,
    pdf_key: inv.pdf_key,
    payload_json: inv.payload_json
  }, filename)
  if (!pdf.ok) return { ok: false, error: pdf.error }
  const bytes = pdf.bytes

  const token = await getGraphToken()
  if (!token) return { ok: false, error: 'graph auth failed' }

  // Resolve site
  const siteResp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${SITE_HOST}:${SITE_PATH}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!siteResp.ok) return { ok: false, error: `site lookup failed: ${await siteResp.text()}` }
  const siteId = (await siteResp.json()).id

  // Get default drive
  const driveResp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!driveResp.ok) return { ok: false, error: `drive lookup failed: ${await driveResp.text()}` }
  const driveId = (await driveResp.json()).id

  // Upload — path-based endpoint auto-creates missing folders
  const targetPath = [DRIVE_PATH_ROOT, cohortSlug, `${yyyy}-${mm}`, filename]
    .map(seg => encodeURIComponent(seg)).join('/')
  const uploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${targetPath}:/content`

  const upResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/pdf'
    },
    body: bytes
  })
  if (!upResp.ok) return { ok: false, error: `upload failed: ${upResp.status} ${await upResp.text()}` }

  const item = await upResp.json()
  const webUrl = item.webUrl

  // Record send row for audit + idempotency.
  // P0-H: this error used to be discarded. The upload is idempotent (PUT with
  // conflictBehavior=replace on the same path), so a duplicate-key error here is
  // benign and expected on a re-run. Any OTHER error means the archive happened
  // but is not recorded, which the caller must know about.
  const { error: sendErr } = await db.from('invoice_sends').insert({
    invoice_id: req.invoice_id,
    target: 'sharepoint',
    mode: 'live',
    address: webUrl,
    message_id: item.id,
    attempts: 1,
    sent_at: new Date().toISOString()
  })

  if (sendErr) {
    const isDuplicate = sendErr.code === '23505' || /duplicate key/i.test(sendErr.message)
    if (!isDuplicate) {
      console.error('[archiveToSharePoint] invoice_sends insert failed:', sendErr.message)
      return {
        ok: false,
        sharepoint_url: webUrl,
        error: `file archived at ${webUrl} but the audit row could not be written: ${sendErr.message}`
      }
    }
  }

  return { ok: true, sharepoint_url: webUrl, ...(pdf.warning ? { warning: pdf.warning } : {}) }
}

async function getGraphToken(): Promise<string | null> {
  const tenant = msEnv('MS_TENANT_ID')
  const clientId = msEnv('MS_CLIENT_ID')
  const secret = msEnv('MS_CLIENT_SECRET')
  if (!tenant || !clientId || !secret) {
    console.error('[archiveToSharePoint] Graph credentials missing or unusable after sanitizing.')
    return null
  }
  const resp = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: secret,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
    })
  })
  if (!resp.ok) return null
  return (await resp.json()).access_token
}
