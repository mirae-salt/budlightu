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

const SITE_HOST = 'ilovesalt.sharepoint.com'
const SITE_PATH = '/sites/Labatt'
const DRIVE_PATH_ROOT = 'CampusBAM/Invoices'  // library path

export async function handler(req: { invoice_id: string }) {
  const db = serviceClient()

  const { data: inv, error } = await db.from('invoices').select('*, bams(*), cohorts(*)').eq('id', req.invoice_id).single()
  if (error || !inv) return { ok: false, error: `invoice not found: ${error?.message}` }
  if (!inv.pdf_key) return { ok: false, error: 'pdf not rendered yet' }

  const bam = (inv as any).bams
  const cohort = (inv as any).cohorts
  const period = new Date(inv.period)
  const yyyy = period.getUTCFullYear()
  const mm = String(period.getUTCMonth() + 1).padStart(2, '0')
  const cohortSlug = cohort.name.replace(/\s+/g, '-')
  const filename = invoicePdfFilename(bam.first_name, bam.last_name, period, inv.invoice_number)

  const { data: pdfFile, error: pdfErr } = await db.storage.from('invoices').download(inv.pdf_key)
  if (pdfErr || !pdfFile) return { ok: false, error: `pdf download failed: ${pdfErr?.message}` }
  const bytes = new Uint8Array(await pdfFile.arrayBuffer())

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
  const targetPath = `${DRIVE_PATH_ROOT}/${cohortSlug}/${yyyy}-${mm}/${filename}`
  const uploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURIComponent(targetPath)}:/content`

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

  // Record send row for audit + idempotency
  await db.from('invoice_sends').insert({
    invoice_id: req.invoice_id,
    target: 'sharepoint',
    mode: 'live',
    address: webUrl,
    message_id: item.id,
    attempts: 1,
    sent_at: new Date().toISOString()
  })

  return { ok: true, sharepoint_url: webUrl }
}

async function getGraphToken(): Promise<string | null> {
  const tenant = process.env.MS_TENANT_ID
  const clientId = process.env.MS_CLIENT_ID
  const secret = process.env.MS_CLIENT_SECRET
  if (!tenant || !clientId || !secret) return null
  const resp = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
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
