export default function FaqPage() {
  return (
    <main className="container" style={{ maxWidth: 700 }}>
      <p className="eyebrow">HELP</p>
      <h1>Frequently asked questions</h1>

      <h2>How much do I get reimbursed each month?</h2>
      <p className="subtle">
        Up to <strong>$150</strong> for Bud Light purchases (based on your submitted receipts). Your monthly salary is separate and is always paid.
      </p>

      <h2>What if I spend less than $150?</h2>
      <p className="subtle">
        You&rsquo;ll be reimbursed for whatever you spent. The unused amount rolls over to next month, up to your program cap.
      </p>

      <h2>What if I forget a month?</h2>
      <p className="subtle">
        Missed months roll forward — you can spend more the next month to catch up. Robin will follow up if this happens often.
      </p>

      <h2>What counts as a valid receipt?</h2>
      <p className="subtle">
        Any receipt showing Bud Light product purchase. Mixed receipts (with groceries or other items) are fine — we only count the Bud Light lines.
      </p>

      <h2>When do I get paid?</h2>
      <p className="subtle">
        Invoices go out around the 16th of each month. Payment (via direct deposit) is <strong>net-15</strong> after Salt&rsquo;s AP team receives the invoice.
      </p>

      <h2>Something else?</h2>
      <p className="subtle">
        <a href="/portal/support" style={{ color: 'var(--teal-sub)' }}>Ask Robin a question →</a>
      </p>
    </main>
  )
}
