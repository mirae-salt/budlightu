import { TopBar } from '../_components/TopBar'

export default function ReceiptsQueue() {
  return (
    <>
      <TopBar crumbs={['Receipts', 'Review queue']} />

      <div className="surface">
        <div className="surface-header">
          <div>
            <div className="surface-title">Human touchpoint 1 · receipt review</div>
            <div className="muted" style={{ fontSize: 12 }}>
              These receipts need your eyes. Auto-approved and cleanly rejected ones aren&rsquo;t shown.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="badge badge-yellow">REVIEW · 0</span>
            <span className="badge badge-red">OCR FAILED · 0</span>
            <span className="badge badge-green">DECIDED TODAY · 0</span>
          </div>
        </div>

        <div className="empty-state">
          No receipts waiting for review. When a BAM uploads a borderline or unclear receipt, it appears here.
        </div>
      </div>
    </>
  )
}
