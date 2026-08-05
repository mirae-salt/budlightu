'use client'

import { useState } from 'react'

type BamMonth = { name: string; initials: string; months: Record<string, number> }

const MONTHS = ['Sept', 'Oct']
const CAP = 150

const FAKE_BAMS: BamMonth[] = [
  { name: 'Lucas Grabowski', initials: 'LG', months: { Sept: 148.50, Oct: 142.30 } },
  { name: 'Kira Sabharwal', initials: 'KS', months: { Sept: 150.00, Oct: 149.80 } },
  { name: 'Marcus Chen', initials: 'MC', months: { Sept: 132.00, Oct: 88.50 } },
  { name: 'Aaliyah Brooks', initials: 'AB', months: { Sept: 145.60, Oct: 150.00 } },
  { name: 'Devon Park', initials: 'DP', months: { Sept: 78.20, Oct: 45.00 } },
  { name: 'Sofia Martinez', initials: 'SM', months: { Sept: 150.00, Oct: 138.90 } },
  { name: 'James Whitfield', initials: 'JW', months: { Sept: 110.50, Oct: 125.40 } },
  { name: 'Priya Nair', initials: 'PN', months: { Sept: 143.70, Oct: 150.00 } },
  { name: 'Ethan Rodriguez', initials: 'ER', months: { Sept: 95.30, Oct: 112.80 } },
  { name: 'Hannah Liu', initials: 'HL', months: { Sept: 150.00, Oct: 147.20 } },
  { name: 'Tyler O\'Brien', initials: 'TO', months: { Sept: 62.40, Oct: 0 } },
  { name: 'Zara Ahmed', initials: 'ZA', months: { Sept: 138.90, Oct: 144.50 } },
]

function shade(spent: number): { bg: string; text: string } {
  if (spent === 0) return { bg: '#EAEEF3', text: '#8B95A3' }
  const pct = spent / CAP
  if (pct < 0.5) return { bg: '#FECACA', text: '#991B1B' }
  if (pct < 0.7) return { bg: '#FED7AA', text: '#9A3412' }
  if (pct < 0.85) return { bg: '#CDE5F4', text: '#0C4A6E' }
  if (pct < 0.95) return { bg: '#8FC9EA', text: '#003D6B' }
  return { bg: '#0088CE', text: '#FFFFFF' }
}

export function HeatmapPlaceholder() {
  const [hoveredCell, setHoveredCell] = useState<string | null>(null)

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 3, fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px', fontSize: 11, color: 'var(--midgray)', fontWeight: 600 }}>BAM</th>
              {MONTHS.map(m => (
                <th key={m} style={{ textAlign: 'center', padding: '4px 8px', fontSize: 11, color: 'var(--midgray)', fontWeight: 600, minWidth: 70 }}>{m}</th>
              ))}
              <th style={{ textAlign: 'right', padding: '4px 8px', fontSize: 11, color: 'var(--midgray)', fontWeight: 600 }}>Avg</th>
            </tr>
          </thead>
          <tbody>
            {FAKE_BAMS.map(bam => {
              const vals = MONTHS.map(m => bam.months[m] ?? 0)
              const avg = vals.reduce((a, b) => a + b, 0) / vals.length
              const avgStyle = shade(avg)
              return (
                <tr key={bam.initials}>
                  <td style={{ padding: '4px 8px', fontWeight: 500, color: 'var(--bl-navy)', whiteSpace: 'nowrap' }}>
                    {bam.initials}
                  </td>
                  {MONTHS.map(m => {
                    const spent = bam.months[m] ?? 0
                    const s = shade(spent)
                    const key = `${bam.initials}-${m}`
                    return (
                      <td
                        key={m}
                        onMouseEnter={() => setHoveredCell(key)}
                        onMouseLeave={() => setHoveredCell(null)}
                        style={{
                          textAlign: 'center', padding: '6px 8px', borderRadius: 4,
                          background: s.bg, color: s.text, fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums', cursor: 'default',
                          position: 'relative',
                        }}
                        title={`${bam.name} | ${m}: $${spent.toFixed(2)} / $${CAP}`}
                      >
                        ${Math.round(spent)}
                        {hoveredCell === key && (
                          <div style={{
                            position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
                            background: 'var(--bl-navy)', color: '#fff', padding: '4px 8px', borderRadius: 4,
                            fontSize: 11, whiteSpace: 'nowrap', zIndex: 10, marginBottom: 4,
                            pointerEvents: 'none',
                          }}>
                            {bam.name}: ${spent.toFixed(2)}
                          </div>
                        )}
                      </td>
                    )
                  })}
                  <td style={{
                    textAlign: 'right', padding: '6px 8px', borderRadius: 4,
                    background: avgStyle.bg, color: avgStyle.text, fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    ${Math.round(avg)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="heatmap-legend" style={{ marginTop: 12 }}>
        <span>$0</span>
        <div className="heatmap-scale">
          {['#EAEEF3', '#FECACA', '#FED7AA', '#CDE5F4', '#8FC9EA', '#0088CE'].map((s, i) => (
            <span key={i} style={{ background: s }} />
          ))}
        </div>
        <span>$150</span>
      </div>
    </>
  )
}
