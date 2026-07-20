import Link from 'next/link'

export default function Dashboard() {
  // TODO: server-side fetch of ledger + this-month receipts for the logged-in BAM.
  // For scaffold: static placeholder that demonstrates layout.
  return (
    <main className="container">
      <p className="eyebrow">MY PORTAL</p>
      <h1>Welcome back</h1>

      <div className="hero-card" style={{ marginTop: 24 }}>
        <div className="eyebrow">THIS MONTH</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ fontSize: 40, fontWeight: 700, color: 'var(--teal-sub)', lineHeight: 1 }}>$0</div>
            <div className="muted" style={{ fontSize: 13 }}>of your $150 allowance used</div>
          </div>
          <Link href="/portal/upload" className="btn" style={{ textDecoration: 'none' }}>Upload receipt</Link>
        </div>
      </div>

      <h2>Recent receipts</h2>
      <p className="subtle">No receipts submitted yet this month.</p>

      <h2>Get help</h2>
      <div className="stack">
        <Link href="/portal/faq" className="card" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
          <strong>FAQ</strong>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Answers to common questions.</p>
        </Link>
        <Link href="/portal/support" className="card" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
          <strong>Contact your program manager</strong>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Can&rsquo;t submit this month? Tell us why.</p>
        </Link>
      </div>
    </main>
  )
}
