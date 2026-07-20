/**
 * Static SVG chart placeholder — visually similar to the reference chart.
 * Will be replaced with Recharts (or similar) when real data flows in.
 */
export function LineChartPlaceholder() {
  // fake path from an "area chart" — evenly spaced x with sample y values
  const points = [30, 35, 32, 40, 55, 48, 62, 58, 65, 72, 68, 75, 78, 74, 82, 80, 85, 88, 90, 87]
  const w = 100, h = 100
  const step = w / (points.length - 1)
  const yFor = (v: number) => h - (v / 100) * h
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(2)} ${yFor(v).toFixed(2)}`).join(' ')
  const area = `${path} L ${w} ${h} L 0 ${h} Z`

  return (
    <div style={{ position: 'relative', width: '100%', height: 240 }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#0BA599" stopOpacity="0.20" />
            <stop offset="100%" stopColor="#0BA599" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#chart-fill)" />
        <path d={path} fill="none" stroke="#215250" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ position: 'absolute', right: 8, top: 4, bottom: 4, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: 10, color: 'var(--midgray)', pointerEvents: 'none' }}>
        <span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: 'var(--midgray)' }}>
        <span>8AM</span><span>10AM</span><span>12PM</span><span>2PM</span><span>4PM</span><span>6PM</span><span>8PM</span><span>10PM</span>
      </div>
    </div>
  )
}
