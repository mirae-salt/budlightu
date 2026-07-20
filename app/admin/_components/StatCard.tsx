type Trend = 'up' | 'down' | 'neutral'
type Props = { label: string; value: string; hint?: string; trend?: Trend; delta?: string }

export function KpiCell({ label, value, hint, trend = 'neutral', delta }: Props) {
  const trendClass = trend === 'up' ? 'trend-up' : trend === 'down' ? 'trend-down' : 'trend-neutral'
  const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '—'
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{hint}</div>}
      {delta && (
        <div className={`kpi-trend ${trendClass}`}>
          <span>{arrow}</span> {delta}
        </div>
      )}
    </div>
  )
}
