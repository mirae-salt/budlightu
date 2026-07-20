export default function ReceiptsQueue() {
  return (
    <main className="container">
      <p className="eyebrow">HUMAN TOUCHPOINT 1</p>
      <h1>Receipt review queue</h1>
      <p className="subtle">
        These receipts need your eyes. Auto-approved and cleanly rejected ones aren&rsquo;t shown.
      </p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <span className="badge badge-yellow">REVIEW (0)</span>
        <span className="badge badge-red">OCR FAILED (0)</span>
        <span className="badge badge-teal">RECENTLY DECIDED (0)</span>
      </div>

      <p className="muted">
        Placeholder — wire up a table of receipts filtered to status IN (&rsquo;review&rsquo;, &rsquo;ocr_failed&rsquo;) with approve/reject actions.
      </p>
    </main>
  )
}
