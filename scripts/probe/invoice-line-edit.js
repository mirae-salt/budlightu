/**
 * Q: do the two queries the invoice line editor depends on actually work against
 *    the live schema, and is any invoice editable right now?
 *
 * schema-drift.js cannot answer this: it strips embedded relations, so
 * `invoices.select('id, bam_id, bams(prov)')` is invisible to it, and a
 * `.not('hst_number','is',null)` filter is not a select at all.
 *
 * READ ONLY. Prints counts and column-presence booleans only. It deliberately
 * never selects `hst_number`, `institution_no`, `transit_no` or `account_no`, and
 * it never calls `decrypt_bam_banking`: whether an HST number EXISTS is all the
 * editor needs, and the value itself has no business being in a log.
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

async function main() {
  const db = serviceClient()

  // 1. the province join used for the tax rate
  const { data: joined, error: joinErr } = await db
    .from('invoices')
    .select('id, bam_id, status, bams(prov)')
    .limit(1)
  if (joinErr) fail(`invoices.select('id, bam_id, bams(prov)') -> ${joinErr.message}`)
  else {
    const row = (joined ?? [])[0]
    const rel = Array.isArray(row?.bams) ? row.bams[0] : row?.bams
    pass(`invoices join to bams(prov) works (embedded shape: ${Array.isArray(row?.bams) ? 'array' : 'object'}, prov present: ${rel ? Object.prototype.hasOwnProperty.call(rel, 'prov') : 'no rows'})`)
  }

  // 2. the HST existence filter. Only the id is selected; the ciphertext is never
  //    fetched and the plaintext is never decrypted.
  const { count: withHst, error: hstErr } = await db
    .from('bams')
    .select('id', { count: 'exact', head: true })
    .not('hst_number', 'is', null)
  if (hstErr) fail(`bams .not('hst_number','is',null) -> ${hstErr.message}`)
  else pass(`HST existence filter works (${withHst ?? 0} BAM(s) have an HST number on file; no value read)`)

  // 3. is anything editable, and does it carry the lines the editor needs?
  const { data: editable, error: edErr } = await db
    .from('invoices')
    .select('id, status, pdf_key, payload_json')
    .in('status', ['draft', 'approved'])
  if (edErr) fail(`editable invoices read -> ${edErr.message}`)
  else {
    const rows = editable ?? []
    const withLines = rows.filter(r => Array.isArray(r.payload_json?.lines)).length
    const withReimb = rows.filter(r => (r.payload_json?.lines ?? []).some(l => /reimbursement/i.test(String(l?.description ?? '')))).length
    const withPdf = rows.filter(r => r.pdf_key).length
    info(`editable invoices: ${rows.length} (draft or approved)`)
    info(`  with a lines[] array in payload_json: ${withLines}`)
    info(`  carrying a reimbursement line (read-only in the editor): ${withReimb}`)
    info(`  with pdf_key set (an edit must clear it): ${withPdf}`)
    if (rows.length > 0 && withLines === 0) {
      fail('editable invoices exist but none has payload_json.lines — the editor would have nothing to show')
    } else {
      pass('editable invoices either carry lines[] or there are none yet')
    }
  }

  verdict('invoice line editor queries')
}
main()
