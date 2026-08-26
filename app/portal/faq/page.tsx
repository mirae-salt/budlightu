import Link from 'next/link'

export default function FaqPage() {
  return (
    <>
      <div className="topbar">
        <div className="crumbs"><span className="now">FAQ</span></div>
      </div>

      <h1>Frequently asked questions</h1>

      <div style={{ maxWidth: 680 }}>
        <div className="surface" style={{ marginTop: 20 }}>
          <h3 style={{ marginTop: 0 }}>How much do I get reimbursed each month?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            Up to <strong>$150</strong> for Bud Light purchases (based on your submitted receipts). Your monthly salary is separate and is always paid.
          </p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>What if I spend less than $150?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            You&rsquo;ll be reimbursed for whatever you spent that month. There is no rollover. Each month resets to $150.
            If you consistently underspend, your program manager may reach out.
          </p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>What if I forget a month?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            You won&rsquo;t receive a reimbursement for that month. There&rsquo;s no way to carry it over.
            Your program manager will follow up if this happens often.
          </p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>What counts as a valid receipt?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            Any receipt showing Bud Light product purchase. Mixed receipts (with groceries or other items) are fine. We only count the Bud Light lines.
          </p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>When do I get paid?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            Invoices go out around the 16th of each month. Payment (via direct deposit) is <strong>net-15</strong> after Salt&rsquo;s AP team receives the invoice.
          </p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0 }}>How does payment work?</h3>
          <p className="subtle" style={{ margin: 0 }}>
            Here&rsquo;s the process: you upload your Bud Light receipts by the 15th &rarr;
            we review them &rarr; your invoice is automatically generated on the 16th with your salary + reimbursement &rarr;
            it gets sent to Salt&rsquo;s Accounts Payable team &rarr; you receive payment via <strong>direct deposit within 15 business days</strong>.
            You&rsquo;ll be CC&rsquo;d on the AP email so you can see when your invoice was submitted.
          </p>
        </div>

        <div style={{ marginTop: 32 }}>
          <p className="eyebrow">CONTENT &amp; POSTING</p>
          <h2 style={{ marginTop: 4 }}>Labatt Legal: Do&rsquo;s &amp; Don&rsquo;ts</h2>
          <p className="subtle" style={{ marginBottom: 16 }}>All BAM social content must follow Labatt&rsquo;s alcohol advertising rules. Violations can get posts taken down or jeopardize the program.</p>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0, color: 'var(--green)' }}>Do</h3>
          <ul className="subtle" style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li>Always include <strong>#BudLightPartner</strong> and <strong>#BudLightU</strong> on every post.</li>
            <li>Tag <strong>@budlightca</strong> on all content.</li>
            <li>Show product in a <strong>responsible, social setting</strong> with friends enjoying together.</li>
            <li>Keep the <strong>number of drinks equal to or less than the number of people</strong> visible.</li>
            <li>Include a <strong>legal-age disclaimer</strong> where required (19+ in Ontario, 18+ in Alberta/Quebec).</li>
            <li>Get <strong>written consent</strong> from anyone appearing in your content.</li>
            <li>Submit content to your program manager for <strong>legal review before posting</strong> when in doubt.</li>
          </ul>
        </div>

        <div className="surface">
          <h3 style={{ marginTop: 0, color: 'var(--red)' }}>Don&rsquo;t</h3>
          <ul className="subtle" style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li><strong>Never show anyone drinking or consuming</strong> alcohol in photos or videos.</li>
            <li><strong>Never show overconsumption</strong> (no excessive bottles, cans, or empties).</li>
            <li><strong>Never show minors</strong> or anyone who appears underage.</li>
            <li><strong>Never post in or near</strong> schools, playgrounds, places of worship, or public transit.</li>
            <li><strong>Never imply</strong> that drinking improves athletic, social, or sexual performance.</li>
            <li><strong>Never link alcohol to driving</strong> (no cars, roads, or driving references).</li>
            <li><strong>Never make health or nutritional claims</strong> about the product.</li>
            <li><strong>Never use language that pressures</strong> anyone to drink (&ldquo;chug,&rdquo; &ldquo;pound,&rdquo; &ldquo;shotgun&rdquo;).</li>
            <li><strong>Never repost or share competitor</strong> beer/alcohol brand content.</li>
          </ul>
        </div>

        <div className="surface" style={{ background: 'var(--bl-fog)' }}>
          <h3 style={{ marginTop: 0 }}>Required hashtags &amp; tags</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['#BudLightPartner', '#BudLightU', '@budlightca'].map(tag => (
                <span key={tag} style={{
                  padding: '4px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                  background: 'var(--bl-blue)', color: '#fff'
                }}>{tag}</span>
              ))}
            </div>
            <p className="subtle" style={{ margin: 0, fontSize: 13 }}>
              These three are <strong>mandatory on every post</strong>. Additional tags for NFL months: <strong>@NFLCanada</strong>. For product content: <strong>#CrispyBoys</strong>.
            </p>
          </div>
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
