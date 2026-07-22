import Link from 'next/link'

export default function FaqPage() {
  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">FAQ</span></div>
      </div>

      <p className="eyebrow">HELP</p>
      <h1>Frequently asked questions</h1>

      <div style={{ maxWidth: 700 }}>
        <div className="surface" style={{ marginTop: 20 }}>
          <h3 style={{ marginTop: 0 }}>How much do I get reimbursed each month?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            Up to <strong>$150</strong> for Bud Light purchases (based on your submitted receipts). Your monthly salary is separate and is always paid.
          </p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>What if I spend less than $150?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            You&rsquo;ll be reimbursed for whatever you spent. The unused amount rolls over to next month, up to your program cap.
          </p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>What if I forget a month?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            Missed months roll forward — you can spend more the next month to catch up. Your program manager will follow up if this happens often.
          </p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>What counts as a valid receipt?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            Any receipt showing Bud Light product purchase. Mixed receipts (with groceries or other items) are fine — we only count the Bud Light lines.
          </p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>When do I get paid?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            Invoices go out around the 16th of each month. Payment (via direct deposit) is <strong>net-15</strong> after Salt&rsquo;s AP team receives the invoice.
          </p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>Something else?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            <Link href="/portal/support" style={{ color: 'var(--bl-blue)' }}>Ask your program manager a question →</Link>
          </p>
        </div>
      </div>
    </>
  )
}
