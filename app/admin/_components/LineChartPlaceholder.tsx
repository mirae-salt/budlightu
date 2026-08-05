/**
 * SVG area chart — shows monthly reimbursement data when available,
 * falls back to static placeholder shape when no data.
 */
export function LineChartPlaceholder({ data }: { data?: Record<string, number> }) {
  const FALLBACK = [30, 35, 32, 40, 55, 48, 62, 58, 65, 72, 68, 75, 78, 74, 82, 80, 85, 88, 90, 87]

  const entries = data ? Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).slice(-12) : []
  const hasReal = entries.length > 0
  const points = hasReal ? entries.map(([, v]) => v) : FALLBACK
  const labels = hasReal
    ? entries.map(([m]) => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' }))
    : ['8AM', '10AM', '12PM', '2PM', '4PM', '6PM', '8PM', '10PM']

  const max = Math.max(...points, 1)
  const w = 100, h = 100
  const step = w / Math.max(points.length - 1, 1)
  const yFor = (v: number) => h - (v / max) * h * 0.9
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(2)} ${yFor(v).toFixed(2)}`).join(' ')
  const area = `${path} L ${w} ${h} L 0 ${h} Z`

  const yLabels = hasReal
    ? [`$${max.toFixed(0)}`, `$${(max * 0.75).toFixed(0)}`, `$${(max * 0.5).toFixed(0)}`, `$${(max * 0.25).toFixed(0)}`, '$0']
    : ['100%', '75%', '50%', '25%', '0%']

  return (
    <div style={{ position: 'relative', width: '100%', height: 240 }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#0088CE" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#0088CE" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#chart-fill)" />
        <path d={path} fill="none" stroke="#003D6B" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ position: 'absolute', right: 8, top: 4, bottom: 4, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: 10, color: 'var(--midgray)', pointerEvents: 'none' }}>
        {yLabels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: 'var(--midgray)' }}>
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </div>
  )
}
