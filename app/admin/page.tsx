export default function AdminDashboard() {
  return (
    <main className="container">
      <p className="eyebrow">PROGRAM ADMIN</p>
      <h1>Dashboard</h1>
      <p className="subtle">Overview of all cohorts, submissions, and money flow.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 24 }}>
        <div className="hero-card"><div className="eyebrow">ACTIVE COHORT</div><div style={{ fontSize: 28, fontWeight: 700 }}>—</div></div>
        <div className="hero-card"><div className="eyebrow">SUBMITTED THIS PERIOD</div><div style={{ fontSize: 28, fontWeight: 700 }}>—</div></div>
        <div className="hero-card"><div className="eyebrow">REVIEW QUEUE</div><div style={{ fontSize: 28, fontWeight: 700, color: 'var(--yellow)' }}>—</div></div>
        <div className="hero-card"><div className="eyebrow">BUDGET USED</div><div style={{ fontSize: 28, fontWeight: 700 }}>—</div></div>
      </div>

      <p className="muted" style={{ marginTop: 24 }}>
        Placeholder dashboard. Wire up server-side queries against the ledger + receipts + invoices tables.
      </p>
    </main>
  )
}
