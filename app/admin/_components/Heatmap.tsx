/**
 * Cohort × month spending heatmap. Cells scale from Stone Light (low) → Teal (high).
 * Placeholder pattern — swap for real data once ledger is populated.
 */
export function HeatmapPlaceholder() {
  const cells = 20 * 6
  const shades = ['#F0F0F0', '#D4EAE7', '#9BD1CC', '#5DB8B1', '#0BA599', '#006F6C']

  return (
    <>
      <div className="heatmap">
        {Array.from({ length: cells }).map((_, i) => {
          const intensity = pseudoRandom(i) < 0.55 ? 0 : Math.floor(pseudoRandom(i * 7) * 6)
          return (
            <div
              key={i}
              className="heatmap-cell"
              style={{ background: shades[intensity] }}
              title={`cell ${i}`}
            />
          )
        })}
      </div>
      <div className="heatmap-legend">
        <span>Low spend</span>
        <div className="heatmap-scale">
          {shades.map((s, i) => <span key={i} style={{ background: s }} />)}
        </div>
        <span>High spend</span>
      </div>
    </>
  )
}

// deterministic-ish placeholder distribution — not real randomness, just varied shading
function pseudoRandom(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}
