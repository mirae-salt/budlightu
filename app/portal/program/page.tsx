'use client'
import Link from 'next/link'

const timeline: { year: string; label?: string; active?: boolean }[] = [
  { year: '2022' },
  { year: '2023' },
  { year: '2024' },
  { year: '2025' },
  { year: '2026', active: true },
]

const links = [
  { href: '/portal/dashboard', label: 'Dashboard' },
  { href: '/portal/upload', label: 'Upload receipts' },
  { href: '/portal/invoices', label: 'Invoices' },
  { href: '/portal/faq', label: 'FAQ' },
]

export default function ProgramPage() {
  return (
    <div className="blu-home">
      <section className="blu-hero">
        <img src="/brand/hero-can-crop.jpg" alt="" className="blu-hero-img" />
        <div className="blu-hero-overlay" />
        <div className="blu-hero-content">
          <p className="blu-hero-eyebrow">Fall 2026</p>
          <h1 className="blu-hero-title">
            Bud Light<br />University
          </h1>
          <div className="blu-hero-nav">
            {links.map((l, i) => (
              <Link key={i} href={l.href} className="blu-hero-link">{l.label}</Link>
            ))}
          </div>
        </div>
      </section>

      <section className="blu-timeline-section">
        <div className="blu-timeline">
          <div className="blu-tl-line" />
          {timeline.map((t, i) => (
            <div key={i} className={`blu-tl-item${t.active ? ' active' : ''}`}>
              <div className="blu-tl-dot" />
              <div className="blu-tl-year">{t.year}</div>
              {t.label && <div className="blu-tl-label">{t.label}</div>}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
