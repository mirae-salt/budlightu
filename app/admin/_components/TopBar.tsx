export function TopBar({ crumbs = ['Dashboard'] }: { crumbs?: string[] }) {
  return (
    <div className="topbar">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={i}>
            <span className={i === crumbs.length - 1 ? 'now' : ''}>{c}</span>
            {i < crumbs.length - 1 && <span className="sep" style={{ margin: '0 6px' }}>›</span>}
          </span>
        ))}
      </div>

      <div className="searchbar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input placeholder='Searching "BAMs" · "invoices" · "receipts"…' />
      </div>

      <div className="user-pill">
        <div className="user-avatar">M</div>
        <div>
          <div className="user-name">Mirae Lee</div>
          <div className="user-email">mirae.lee@ilovesalt.com</div>
        </div>
      </div>
    </div>
  )
}
