import Link from 'next/link'

export default function Home() {
  return (
    <main className="container">
      <p className="eyebrow">BUD LIGHT U</p>
      <h1>BAM Portal</h1>
      <p className="subtle">
        Submit your receipts, check your reimbursement status, and get help.
      </p>

      <div className="hero-card" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>Log in</h2>
        <p className="subtle">
          Enter your email — we&rsquo;ll send you a 6-digit code to sign in.
        </p>
        <Link href="/portal/login" className="btn" style={{ display: 'inline-block', marginTop: 12, textDecoration: 'none' }}>
          Continue
        </Link>
      </div>

      <p className="muted" style={{ marginTop: 32, fontSize: 13 }}>
        New here? Check your email for an onboarding link from Robin or Jenna.
      </p>
    </main>
  )
}
