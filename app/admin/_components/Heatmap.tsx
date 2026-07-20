/**
 * Cohort × month spending heatmap. Cells scale from Stone Light (low) → Teal (high).
 * Placeholder pattern — swap for real data once ledger is populated.
 */
export function HeatmapPlaceholder() {
  const cells = 20 * 6
  const shades = ['#EAEEF3', '#CDE5F4', '#8FC9EA', '#4DA9DB', '#0088CE', '#003D6B']

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
