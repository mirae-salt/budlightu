import { TopBar } from '../_components/TopBar'
import { REVIEW_QUEUE } from '../_lib/dummy'

export default function ReceiptsQueue() {
  const reviewCount    = REVIEW_QUEUE.filter(r => r.status === 'review').length
  const ocrFailedCount = REVIEW_QUEUE.filter(r => r.status === 'ocr_failed').length

  return (
    <>
      <TopBar crumbs={['Receipts', 'Review queue']} />

      <div className="surface">
        <div className="surface-header">
          <div className="surface-title">Review queue · touchpoint 1</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="badge badge-yellow">REVIEW · {reviewCount}</span>
            <span className="badge badge-red">OCR FAILED · {ocrFailedCount}</span>
            <span className="badge badge-green">DECIDED TODAY · 2</span>
          </div>
        </div>

        <table className="admin-table">
          <thead>
            <tr>
              <th>BAM</th><th>Uploaded</th><th>Total</th><th>Reason</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {REVIEW_QUEUE.map((r, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 600 }}>{r.bam}</td>
                <td className="muted">{r.uploadedAt}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{r.total}</td>
                <td className="muted" style={{ fontSize: 12.5, maxWidth: 320 }}>{r.reason}</td>
                <td>
                  {r.status === 'review'
                    ? <span className="badge badge-yellow">REVIEW</span>
                    : <span className="badge badge-red">OCR FAILED</span>}
                </td>
                <td>
                  <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
