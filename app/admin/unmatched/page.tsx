export default function Unmatched() {
  return (
    <main className="container">
      <p className="eyebrow">ONBOARDING · TRIAGE</p>
      <h1>Unmatched submissions</h1>
      <p className="subtle">
        Students whose email didn&rsquo;t match the pending roster. Usually an email typo &mdash; fix the roster row and re-match, or reject.
      </p>

      <p className="muted" style={{ marginTop: 16, fontSize: 13 }}>
        <strong>Privacy:</strong> banking fields are never stored for unmatched submissions. Only the email + non-sensitive fields are shown here.
      </p>

      <p className="muted" style={{ marginTop: 16 }}>
        Placeholder — table of onboarding_submissions_summary (super-admin view has the full record, program-admin sees this summary only).
      </p>
    </main>
  )
}
