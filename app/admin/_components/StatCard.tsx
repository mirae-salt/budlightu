type Trend = 'up' | 'down' | 'neutral'
type Props = { label: string; value: string; hint?: string; trend?: Trend; delta?: string; onClick?: () => void }

export function KpiCell({ label, value, hint, trend = 'neutral', delta, onClick }: Props) {
  const trendClass = trend === 'up' ? 'trend-up' : trend === 'down' ? 'trend-down' : 'trend-neutral'
  const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '—'
  return (
    <div
      className="kpi"
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick() } : undefined}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">
        {value.includes(' / ') ? (
          <>{value.split(' / ')[0]} <span className="kpi-denom">/ {value.split(' / ')[1]}</span></>
        ) : value}
      </div>
      {hint && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{hint}</div>}
      {delta && (
        <div className={`kpi-trend ${trendClass}`}>
          <span>{arrow}</span> {delta}
        </div>
      )}
    </div>
  )
}
