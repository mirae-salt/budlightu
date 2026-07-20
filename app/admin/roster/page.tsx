export default function Roster() {
  return (
    <main className="container">
      <p className="eyebrow">ROSTER</p>
      <h1>BAMs</h1>
      <p className="subtle">Add, edit, or archive BAMs. New BAMs enter as <em>pending</em> until they complete onboarding.</p>

      <div style={{ margin: '16px 0', display: 'flex', gap: 8 }}>
        <span className="badge badge-teal">ACTIVE (0)</span>
        <span className="badge badge-yellow">PENDING (0)</span>
        <span className="badge badge-red">ARCHIVED (0)</span>
      </div>

      <p className="muted">
        Placeholder — sortable table of BAMs with quick actions: send invite, resend OTP, archive, view ledger.
      </p>
    </main>
  )
}
