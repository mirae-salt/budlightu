export default function InvoiceBatch() {
  return (
    <main className="container">
      <p className="eyebrow">HUMAN TOUCHPOINT 2</p>
      <h1>Invoice batch approval</h1>
      <p className="subtle">
        Draft invoices for the current period. Preview PDFs, spot-check, then approve the batch to send.
      </p>

      <div className="hero-card" style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="eyebrow">SEND MODE</div>
          <div><span className="badge badge-yellow">DRYRUN</span> &nbsp; <span className="muted" style={{ fontSize: 13 }}>Drafts will be created in Outlook — no live send.</span></div>
        </div>
        <button disabled>Approve batch (0)</button>
      </div>

      <h2>Drafts</h2>
      <p className="muted">
        Placeholder — list of draft invoices with PDF preview + inline flags.
      </p>
    </main>
  )
}
