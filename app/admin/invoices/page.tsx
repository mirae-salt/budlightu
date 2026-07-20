import { TopBar } from '../_components/TopBar'
import { DRAFT_INVOICES } from '../_lib/dummy'

export default function InvoiceBatch() {
  const total = DRAFT_INVOICES.reduce((sum, inv) => sum + parseFloat(inv.amount.replace(/[$,]/g,'')), 0)
  return (
    <>
      <TopBar crumbs={['Invoices', 'Batch approval']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Batch approval · touchpoint 2</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="badge badge-yellow">SEND MODE · DRYRUN</span>
            <span className="muted" style={{ fontSize: 12 }}>Total: <strong>${total.toFixed(2)}</strong></span>
            <button>Approve batch ({DRAFT_INVOICES.length})</button>
          </div>
        </div>

        <table className="admin-table">
          <thead>
            <tr>
              <th>Invoice #</th><th>BAM</th><th>Period</th><th>Amount</th><th>Flag</th><th></th>
            </tr>
          </thead>
          <tbody>
            {DRAFT_INVOICES.map(inv => (
              <tr key={inv.number}>
                <td style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--bl-navy)' }}>{inv.number}</td>
                <td style={{ fontWeight: 600 }}>{inv.bam}</td>
                <td className="muted">{inv.period}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{inv.amount}</td>
                <td>
                  {inv.flag
                    ? <span className="badge badge-yellow">{inv.flag}</span>
                    : <span className="muted" style={{ fontSize: 12 }}>—</span>}
                </td>
                <td>
                  <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}>Preview PDF</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
