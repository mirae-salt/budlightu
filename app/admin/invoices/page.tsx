import { TopBar } from '../_components/TopBar'

export default function InvoiceBatch() {
  return (
    <>
      <TopBar crumbs={['Invoices', 'Batch approval']} />

      <div className="surface">
        <div className="surface-header">
          <div>
            <div className="surface-title">Human touchpoint 2 · invoice batch</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Draft invoices for the current cycle. Preview PDFs, spot-check, approve the batch to send.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="badge badge-yellow">SEND MODE · DRYRUN</span>
            <button disabled>Approve batch (0)</button>
          </div>
        </div>

        <div className="empty-state">
          No draft invoices yet. Scheduler generates the batch on the 16th of each month.
        </div>
      </div>
    </>
  )
}
